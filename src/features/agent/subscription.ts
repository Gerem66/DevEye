import { agentCollect, agentSubscribe, agentUnsubscribe, type DeviceRow } from '@deveye/types';

import { authorizeDevice } from '@/agent/authorize';
import { parseDeviceReport } from '@/agent/mappers';
import { defineFeature, type FeatureDefinition } from '../_define';

/**
 * L'abonnement d'une socket aux poussées d'un appareil (métriques, rapports,
 * sortie de terminal, morceaux de fichiers) et la collecte à la demande. Rien
 * n'est écrit côté serveur : c'est l'état d'une connexion, tenu par le hub.
 */

export const agentSubscribeFeature: FeatureDefinition<
    typeof agentSubscribe.command,
    typeof agentSubscribe.input,
    typeof agentSubscribe.output
> = defineFeature({
    ...agentSubscribe,
    access: { feature: 'devices', level: 'read' },
    handler: async (ctx, input) => {
        // Le schéma autorise 50 identifiants, et cette commande part à chaque
        // changement d'appareil et à chaque réouverture de socket : la séquence
        // d'origine (une autorisation, puis un `latest` + un `nearest`, trois
        // requêtes à lui seul, par appareil, l'un après l'autre) valait jusqu'à
        // deux cents allers-retours pour un seul appel. Tout est parallèle.
        const allowed: { id: string; row: DeviceRow }[] = await Promise.all(
            input.deviceIds.map(async (deviceId) => ({ id: deviceId, row: await authorizeDevice(ctx, deviceId) }))
        );
        const ids = allowed.map((a) => a.id);
        ctx.monitor?.subscribe(ids);

        // Push the latest stored instant + report straight away so the UI shows
        // data immediately rather than waiting for the next live sample. The
        // instant's process list is seeded too: it now travels with the metric
        // stream, so without it the process table would stay empty for a whole
        // collection cadence.
        await Promise.all(
            allowed.map(async ({ id, row }) => {
                const point = await ctx.db.metrics.latest(id);
                const sample = point ? await ctx.db.processSamples.nearest(id, point.timestamp) : null;
                ctx.monitor?.sendInitial(id, point, sample, parseDeviceReport(row.report_json));
            })
        );
        return { deviceIds: ids };
    }
});

/**
 * Se désabonner ne demande aucun droit, à dessein : exiger `devices: read` pour
 * *cesser* de recevoir laisserait une souscription orpheline chez qui vient
 * justement de perdre l'accès. La diffusion, elle, est filtrée en continu par le
 * hub (voir `MonitorHub.rememberGrants`).
 */
export const agentUnsubscribeFeature: FeatureDefinition<
    typeof agentUnsubscribe.command,
    typeof agentUnsubscribe.input,
    typeof agentUnsubscribe.output
> = defineFeature({
    ...agentUnsubscribe,
    handler: async (ctx, input) => {
        ctx.monitor?.unsubscribe(input.deviceIds);
        return { deviceIds: input.deviceIds };
    }
});

/** Ask the device's agent to push a fresh sample + report now. */
export const agentCollectFeature: FeatureDefinition<
    typeof agentCollect.command,
    typeof agentCollect.input,
    typeof agentCollect.output
> = defineFeature({
    ...agentCollect,
    access: { feature: 'devices', level: 'read' },
    handler: async (ctx, input) => {
        await authorizeDevice(ctx, input.deviceId);
        const requested = ctx.monitor?.requestCollect(input.deviceId) ?? false;
        return { deviceId: input.deviceId, requested };
    }
});
