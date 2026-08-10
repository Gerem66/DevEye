import {
    metricsAvailability,
    metricsDeleteSnapshots,
    metricsPresence,
    metricsProcessesAt,
    metricsQuery,
    metricsRefresh,
    metricsSetSnapshotsPinned,
    metricsSnapshots,
    metricsStorage,
    metricsSubscribe,
    metricsUnsubscribe,
    type DeviceRow
} from 'deveye-types';

import { parseDeviceReport } from '@/agent/mappers';
import { env } from '@/Utils/Env';
import { defineFeature, type FeatureContext, type FeatureDefinition } from '../_define';
import { authorizeDevice } from '../devices/shared';

/**
 * De quel appareil parle-t-on, et m'est-il accessible ?
 *
 * Délègue à `authorizeDevice`, garde unique des appareils : il n'y avait aucune
 * raison que la supervision porte sa propre copie de la règle — et le nom
 * `authorizeRead` qu'elle portait a laissé passer deux commandes destructrices
 * (`metrics.deleteSnapshots`, `metrics.setSnapshotsPinned`) sous une garde de
 * lecture. Le *niveau* exigé est désormais déclaré par chaque commande dans son
 * `access`, appliqué par le dispatcheur avant le handler.
 */
async function device(ctx: FeatureContext, deviceId: string): Promise<DeviceRow> {
    return authorizeDevice(ctx, deviceId);
}

export const metricsQueryFeature: FeatureDefinition<
    typeof metricsQuery.command,
    typeof metricsQuery.input,
    typeof metricsQuery.output
> = defineFeature({
    ...metricsQuery,
    access: { feature: 'devices', level: 'read' },
    handler: async (ctx, input) => {
        await device(ctx, input.deviceId);
        const points = await ctx.db.metrics.query({
            deviceId: input.deviceId,
            from: input.from,
            to: input.to,
            resolution: input.resolution
        });
        return { deviceId: input.deviceId, points };
    }
});

export const metricsSubscribeFeature: FeatureDefinition<
    typeof metricsSubscribe.command,
    typeof metricsSubscribe.input,
    typeof metricsSubscribe.output
> = defineFeature({
    ...metricsSubscribe,
    access: { feature: 'devices', level: 'read' },
    handler: async (ctx, input) => {
        // Le schéma autorise 50 identifiants, et cette commande part à chaque
        // changement d'appareil et à chaque réouverture de socket : la séquence
        // d'origine (une autorisation, puis un `latest` + un `nearest` — trois
        // requêtes à lui seul — par appareil, l'un après l'autre) valait jusqu'à
        // deux cents allers-retours pour un seul appel. Tout est parallèle.
        const allowed: { id: string; row: DeviceRow }[] = await Promise.all(
            input.deviceIds.map(async (deviceId) => ({ id: deviceId, row: await device(ctx, deviceId) }))
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
export const metricsUnsubscribeFeature: FeatureDefinition<
    typeof metricsUnsubscribe.command,
    typeof metricsUnsubscribe.input,
    typeof metricsUnsubscribe.output
> = defineFeature({
    ...metricsUnsubscribe,
    handler: async (ctx, input) => {
        ctx.monitor?.unsubscribe(input.deviceIds);
        return { deviceIds: input.deviceIds };
    }
});

export const metricsRefreshFeature: FeatureDefinition<
    typeof metricsRefresh.command,
    typeof metricsRefresh.input,
    typeof metricsRefresh.output
> = defineFeature({
    ...metricsRefresh,
    access: { feature: 'devices', level: 'read' },
    handler: async (ctx, input) => {
        await device(ctx, input.deviceId);
        const requested = ctx.monitor?.requestCollect(input.deviceId) ?? false;
        return { deviceId: input.deviceId, requested };
    }
});

export const metricsPresenceFeature: FeatureDefinition<
    typeof metricsPresence.command,
    typeof metricsPresence.input,
    typeof metricsPresence.output
> = defineFeature({
    ...metricsPresence,
    access: { feature: 'devices', level: 'read' },
    handler: async (ctx, input) => {
        await device(ctx, input.deviceId);
        const [onlineAtStart, events] = await Promise.all([
            ctx.db.presence.onlineAt(input.deviceId, input.from),
            ctx.db.presence.query(input.deviceId, input.from, input.to)
        ]);
        return { deviceId: input.deviceId, onlineAtStart, events };
    }
});

export const metricsProcessesAtFeature: FeatureDefinition<
    typeof metricsProcessesAt.command,
    typeof metricsProcessesAt.input,
    typeof metricsProcessesAt.output
> = defineFeature({
    ...metricsProcessesAt,
    access: { feature: 'devices', level: 'read' },
    handler: async (ctx, input) => {
        await device(ctx, input.deviceId);
        const sample = await ctx.db.processSamples.nearest(input.deviceId, input.at);
        return { deviceId: input.deviceId, sample };
    }
});

export const metricsAvailabilityFeature: FeatureDefinition<
    typeof metricsAvailability.command,
    typeof metricsAvailability.input,
    typeof metricsAvailability.output
> = defineFeature({
    ...metricsAvailability,
    access: { feature: 'devices', level: 'read' },
    handler: async (ctx, input) => {
        await device(ctx, input.deviceId);
        const days = await ctx.db.metrics.availableDays(input.deviceId, input.tzOffsetMinutes);
        return { deviceId: input.deviceId, days };
    }
});

export const metricsSnapshotsFeature: FeatureDefinition<
    typeof metricsSnapshots.command,
    typeof metricsSnapshots.input,
    typeof metricsSnapshots.output
> = defineFeature({
    ...metricsSnapshots,
    access: { feature: 'devices', level: 'read' },
    handler: async (ctx, input) => {
        await device(ctx, input.deviceId);
        // The marks are the *metric* instants: process capture is optional, and
        // keying them on the process blob left a `processCapture: 'off'` device
        // with an empty timeline — no marks, and the ‹ › / arrow-key stepping
        // permanently disabled. The process samples only qualify which instants
        // carry a list, and still supply the pinned set they pin in lockstep.
        const [instants, samples] = await Promise.all([
            ctx.db.metrics.instantTimes(input.deviceId, input.from, input.to),
            ctx.db.processSamples.snapshotTimes(input.deviceId, input.from, input.to)
        ]);
        // Les épingles sont posées sur les deux tables dans une seule
        // transaction (`metrics.setSnapshotsPinned`) : les instants métriques
        // font foi, et il n'y a plus de moitié d'épingle à rattraper.
        return {
            deviceId: input.deviceId,
            timestamps: instants.timestamps,
            pinned: instants.pinned,
            withProcesses: samples.timestamps,
            truncated: instants.truncated
        };
    }
});

export const metricsStorageFeature: FeatureDefinition<
    typeof metricsStorage.command,
    typeof metricsStorage.input,
    typeof metricsStorage.output
> = defineFeature({
    ...metricsStorage,
    access: { feature: 'devices', level: 'read' },
    handler: async (ctx, input) => {
        await device(ctx, input.deviceId);
        const usage = await ctx.db.processSamples.storage(input.deviceId);
        return { deviceId: input.deviceId, ...usage };
    }
});

export const metricsDeleteSnapshotsFeature: FeatureDefinition<
    typeof metricsDeleteSnapshots.command,
    typeof metricsDeleteSnapshots.input,
    typeof metricsDeleteSnapshots.output
> = defineFeature({
    ...metricsDeleteSnapshots,
    mutates: true,
    // Effacer définitivement l'historique d'une machine n'est pas de la lecture,
    // et la garde qui couvrait cette commande s'appelait littéralement
    // `authorizeRead` : tout membre de l'espace pouvait supprimer les relevés
    // conservés par un autre.
    access: { feature: 'devices', level: 'write' },
    handler: async (ctx, input) => {
        const row = await device(ctx, input.deviceId);
        const { snapshots } = await ctx.db.processSamples.deleteRange(input.deviceId, input.from, input.to);
        if (snapshots > 0) {
            const single = input.from === input.to;
            ctx.audit({
                action: 'metrics.deleteSnapshots',
                level: 'warning',
                description: single
                    ? `Snapshot supprimé : « ${row.name} »`
                    : `${snapshots} snapshots supprimés : « ${row.name} »`,
                metadata: { deviceId: row.id, from: input.from, to: input.to, snapshots }
            });
        }
        return { deviceId: input.deviceId, deletedSnapshots: snapshots };
    }
});

export const metricsSetSnapshotsPinnedFeature: FeatureDefinition<
    typeof metricsSetSnapshotsPinned.command,
    typeof metricsSetSnapshotsPinned.input,
    typeof metricsSetSnapshotsPinned.output
> = defineFeature({
    ...metricsSetSnapshotsPinned,
    mutates: true,
    // Épingler soustrait des relevés à la purge, désépingler les y rend — et
    // peut en supprimer sur-le-champ. Même niveau que la suppression.
    access: { feature: 'devices', level: 'write' },
    handler: async (ctx, input) => {
        const row = await device(ctx, input.deviceId);
        const { deviceId, from, to, pinned } = input;

        // Pin/unpin the whole instant (process list + metric point) so a saved
        // moment stays fully consultable past the device's retention. Le compte
        // porte sur les instants **métriques** : une machine en
        // `processCapture: 'off'` n'a aucune liste de processus, et le compter
        // sur elles rendait « 0 épinglé » — sans la moindre ligne de journal —
        // alors que les relevés venaient bien d'être conservés.
        const snapshots = await ctx.db.metrics.setInstantsPinned(deviceId, from, to, pinned);

        // On unpin, the rows revert to normal retention: drop those already past
        // their deadline right now; the rest expire at the next hourly sweep.
        let deletedSnapshots = 0;
        if (!pinned) {
            const [proc] = await Promise.all([
                ctx.db.processSamples.deleteExpiredInRange(deviceId, from, to, env.MONITORING_RETENTION_DAYS),
                ctx.db.metrics.deleteExpiredInRange(deviceId, from, to, env.MONITORING_RETENTION_DAYS)
            ]);
            deletedSnapshots = proc.snapshots;
        }

        if (snapshots > 0) {
            ctx.audit({
                action: 'metrics.setSnapshotsPinned',
                description: pinned
                    ? `${snapshots} snapshot(s) épinglé(s) : « ${row.name} »`
                    : `${snapshots} snapshot(s) désépinglé(s) : « ${row.name} »`,
                metadata: { deviceId, from, to, pinned, snapshots, deletedSnapshots }
            });
        }

        return { deviceId, affected: snapshots, deletedSnapshots };
    }
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const metricsFeatures: FeatureDefinition<string, any, any>[] = [
    metricsQueryFeature,
    metricsSubscribeFeature,
    metricsUnsubscribeFeature,
    metricsRefreshFeature,
    metricsPresenceFeature,
    metricsProcessesAtFeature,
    metricsAvailabilityFeature,
    metricsSnapshotsFeature,
    metricsStorageFeature,
    metricsDeleteSnapshotsFeature,
    metricsSetSnapshotsPinnedFeature
];
