import type { Device, DeviceRow } from '@deveye/types';

import { FeatureError, type FeatureContext } from '@/features/_define';
import { isPlanPaused } from '@/Services/planPauses';
import { metricIntervalOf } from './cadence';
import { computeAgentUpdate, deviceRowToDevice } from './mappers';
import { agentDistDir, readServedManifestCached } from './sync';

/**
 * Ce qu'il faut pour décider si un appareil est visible : un `FeatureContext` le
 * porte, la façade du SDK aussi, sans session ni socket. `assertItem` n'existe
 * que sur le premier : un service de fond agit pour le module, pas pour un rôle.
 */
export type DeviceScope = Pick<FeatureContext, 'db' | 'workspaceId'> & Partial<Pick<FeatureContext, 'assertItem'>>;

/**
 * Charge un appareil que l'appelant a le droit d'atteindre, sinon lève.
 *
 * La frontière est l'espace : le domicile de l'appareil, ou une projection vers
 * l'espace actif. Sans dérogation, l'administrateur global compris : il n'a rien
 * de particulier sur les appareils d'un espace où il n'entre pas. Le niveau de
 * droit exigé n'est pas décidé ici : chaque commande le déclare dans son
 * `access`. La restriction par élément, elle, se pose ici dès que l'appelant a
 * un rôle : un appareil masqué pour ce rôle n'est pas plus atteignable par
 * abonnement que par la liste.
 */
export async function authorizeDevice(scope: DeviceScope, deviceId: string): Promise<DeviceRow> {
    const row = await scope.db.devices.findVisible(deviceId, scope.workspaceId);
    if (!row) throw new FeatureError('not_found', 'Appareil introuvable');
    if (scope.assertItem) await scope.assertItem('devices', row.id, 'read');
    return row;
}

/** Live presence for the given device ids (all false off a non-WS connection). */
export function online(ctx: FeatureContext, ids: string[]): Record<string, boolean> {
    return ctx.monitor?.isOnline(ids) ?? Object.fromEntries(ids.map((id) => [id, false]));
}

/** Map a row to the client shape, with live presence + computed self-update info. */
export async function toDevice(ctx: FeatureContext, row: DeviceRow): Promise<Device> {
    const manifest = await readServedManifestCached(agentDistDir());
    return deviceRowToDevice(
        row,
        await metricIntervalOf(ctx.db, row),
        online(ctx, [row.id])[row.id] ?? false,
        computeAgentUpdate(row, manifest),
        row.workspace_id !== ctx.workspaceId
    );
}

/**
 * Comme {@link authorizeDevice}, mais exige en plus que l'agent soit joignable :
 * pour les commandes qui ne font que relayer un ordre à la machine. Un appareil
 * masqué ou passé en lecture seule pour le rôle de l'appelant ne prend pas
 * d'ordre.
 *
 * La surcharge est lue directement, et non par `ctx.assertItem(…, 'write')` :
 * celui-ci réclamerait l'écriture, alors que le droit d'agir sur la machine
 * vient de la permission que la commande déclare (`access.extras`). Gérer la
 * flotte et piloter une machine ne sont pas le même droit. Seule une surcharge
 * QUI ABAISSE ferme la porte ici : un appareil passé en lecture seule pour un
 * rôle ne prend pas d'ordre, quelles que soient ses permissions.
 */
export async function authorizeReachableDevice(ctx: FeatureContext, deviceId: string): Promise<DeviceRow> {
    const row = await authorizeDevice(ctx, deviceId);
    const override = (await ctx.itemRestrictions('devices')).get(row.id);
    if (override === 'none') throw new FeatureError('forbidden', 'Cet appareil ne vous est pas accessible');
    if (override === 'read') {
        throw new FeatureError('forbidden', 'Cet appareil est en lecture seule pour votre rôle');
    }
    // La permission que la commande déclare, éprouvée contre CET appareil : le
    // dispatcheur ne l'a vue qu'à l'échelle de la fonctionnalité.
    await ctx.assertItemExtras('devices', row.id);
    // Avant « hors ligne » : la socket refuse ces deux-là, la raison à dire
    // est leur statut.
    if (row.status === 'pending') {
        throw new FeatureError('conflict', 'Cet appareil attend une approbation : son agent n’est pas admis');
    }
    if (row.status === 'archived') {
        throw new FeatureError('conflict', 'Cet appareil est archivé : son agent n’existe plus');
    }
    // Un appareil en pause est hors ligne aussi, mais la raison à dire est
    // l'offre, avec son invite.
    if (isPlanPaused('devices.agents', row.id)) {
        throw new FeatureError('quota_exceeded', 'Cet appareil est en pause : il dépasse la limite de l’offre.', {
            key: 'devices.agents',
            paused: true
        });
    }
    if (!(online(ctx, [row.id])[row.id] ?? false)) {
        throw new FeatureError('conflict', 'Agent hors ligne');
    }
    return row;
}
