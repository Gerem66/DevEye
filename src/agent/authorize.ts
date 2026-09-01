import type { Device, DeviceRow } from '@deveye/types';

import { FeatureError, type FeatureContext } from '@/features/_define';
import { computeAgentUpdate, deviceRowToDevice } from './mappers';
import { agentDistDir, readServedManifestCached } from './sync';

/**
 * Ce qu'il faut pour décider si un appareil est visible : un `FeatureContext` le
 * porte, la façade du SDK aussi, sans session ni socket.
 */
export type DeviceScope = Pick<FeatureContext, 'db' | 'workspaceId'>;

/**
 * Charge un appareil que l'appelant a le droit d'atteindre, sinon lève.
 *
 * La frontière est l'espace : le domicile de l'appareil, ou une projection vers
 * l'espace actif. Sans dérogation, l'administrateur global compris : il n'a rien
 * de particulier sur les appareils d'un espace où il n'entre pas. Le niveau de
 * droit exigé n'est pas décidé ici : chaque commande le déclare dans son
 * `access`, et la restriction par élément se pose par `ctx.assertItem`.
 */
export async function authorizeDevice(scope: DeviceScope, deviceId: string): Promise<DeviceRow> {
    const row = await scope.db.devices.findVisible(deviceId, scope.workspaceId);
    if (!row) throw new FeatureError('not_found', 'Appareil introuvable');
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
 * La restriction est lue directement, et non par `ctx.assertItem(…, 'write')` :
 * celui-ci réclamerait aussi l'écriture sur la FONCTIONNALITÉ, alors que le
 * droit d'agir sur la machine vient de la permission que la commande déclare
 * (`access.extras`). Gérer la flotte et piloter une machine ne sont pas le
 * même droit.
 */
export async function authorizeReachableDevice(ctx: FeatureContext, deviceId: string): Promise<DeviceRow> {
    const row = await authorizeDevice(ctx, deviceId);
    const restriction = (await ctx.itemRestrictions('devices')).get(row.id);
    if (restriction === 'none') throw new FeatureError('forbidden', 'Cet appareil ne vous est pas accessible');
    if (restriction === 'read') {
        throw new FeatureError('forbidden', 'Cet appareil est en lecture seule pour votre rôle');
    }
    // La permission que la commande déclare, éprouvée contre CET appareil : le
    // dispatcheur ne l'a vue qu'à l'échelle de la fonctionnalité.
    await ctx.assertItemExtras('devices', row.id);
    if (!(online(ctx, [row.id])[row.id] ?? false)) {
        throw new FeatureError('conflict', 'Agent hors ligne');
    }
    return row;
}
