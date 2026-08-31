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
 * pour les commandes qui ne font que relayer un ordre à la machine. La
 * restriction de rôle sur cette ligne s'y ajoute : un appareil masqué ou en
 * lecture seule ne prend pas d'ordre.
 */
export async function authorizeReachableDevice(ctx: FeatureContext, deviceId: string): Promise<DeviceRow> {
    const row = await authorizeDevice(ctx, deviceId);
    await ctx.assertItem('devices', row.id, 'write');
    if (!(online(ctx, [row.id])[row.id] ?? false)) {
        throw new FeatureError('conflict', 'Agent hors ligne');
    }
    return row;
}
