import type { Device, DeviceRow } from 'deveye-types';

import { computeAgentUpdate, deviceRowToDevice } from '@/agent/mappers';
import { agentDistDir, readServedManifestCached } from '@/agent/sync';
import { FeatureError, type FeatureContext } from '../_define';

/**
 * Charge un appareil que l'appelant a le droit de gérer, sinon lève.
 *
 * La frontière est **l'espace** : un appareil se gère depuis l'espace où il est
 * rangé. L'administrateur global garde son dérogation, parce que la page
 * Appareils gère la flotte entière, y compris des machines d'espaces dont il
 * n'est pas membre.
 *
 * Les commandes de gestion de flotte (appairage, approbation, révocation,
 * renommage, suppression) déclarent en plus `access: { admin: true }` : la garde
 * est alors appliquée par le dispatcheur, pas répétée ici.
 */
export async function authorizeDevice(ctx: FeatureContext, deviceId: string): Promise<DeviceRow> {
    const row = await ctx.db.devices.findById(deviceId);
    if (!row) throw new FeatureError('not_found', 'Device not found');
    if (row.workspace_id !== ctx.workspaceId && !ctx.isAdmin) {
        throw new FeatureError('forbidden', 'Not allowed to manage this device');
    }
    return row;
}

/** Live presence for the given device ids (all false off a non-WS connection). */
export function online(ctx: FeatureContext, ids: string[]): Record<string, boolean> {
    return ctx.monitor?.isOnline(ids) ?? Object.fromEntries(ids.map((id) => [id, false]));
}

/** Map a row to the client shape, with live presence + computed self-update info. */
export async function toDevice(ctx: FeatureContext, row: DeviceRow): Promise<Device> {
    const manifest = await readServedManifestCached(agentDistDir());
    return deviceRowToDevice(row, online(ctx, [row.id])[row.id] ?? false, computeAgentUpdate(row, manifest));
}

/** Admin guard that also requires the agent to be online (for pushed commands). */
export async function authorizeOnlineDevice(ctx: FeatureContext, deviceId: string): Promise<DeviceRow> {
    ctx.assertAdmin();
    const row = await authorizeDevice(ctx, deviceId);
    if (!(online(ctx, [row.id])[row.id] ?? false)) {
        throw new FeatureError('conflict', 'Agent hors ligne');
    }
    return row;
}

/**
 * Owner-or-admin guard that also requires the agent to be online. Like
 * `authorizeOnlineDevice` but *without* the admin-only gate — for Monitoring
 * commands the device owner may drive too (e.g. live power actions), as with
 * `device.setConfig`/`device.delete`.
 */
export async function authorizeReachableDevice(ctx: FeatureContext, deviceId: string): Promise<DeviceRow> {
    const row = await authorizeDevice(ctx, deviceId);
    if (!(online(ctx, [row.id])[row.id] ?? false)) {
        throw new FeatureError('conflict', 'Agent hors ligne');
    }
    return row;
}
