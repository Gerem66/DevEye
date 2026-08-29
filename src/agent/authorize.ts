import type { Device, DeviceRow } from '@deveye/types';

import { FeatureError, type FeatureContext } from '@/features/_define';
import { computeAgentUpdate, deviceRowToDevice } from './mappers';
import { agentDistDir, readServedManifestCached } from './sync';

/**
 * Ce qu'il faut pour décider si un appareil est visible : un `FeatureContext` le
 * porte, la façade du SDK aussi, sans session ni socket.
 */
export type DeviceScope = Pick<FeatureContext, 'db' | 'isAdmin' | 'workspaceId'>;

/**
 * Charge un appareil que l'appelant a le droit d'atteindre, sinon lève.
 *
 * La frontière est le partage (`device_workspaces`), pas l'espace d'appairage ;
 * seule dérogation, l'administrateur global, qui gère la flotte entière. Le
 * niveau de droit exigé n'est pas décidé ici : chaque commande le déclare dans
 * son `access`.
 */
export async function authorizeDevice(scope: DeviceScope, deviceId: string): Promise<DeviceRow> {
    const row = await scope.db.devices.findById(deviceId);
    if (!row) throw new FeatureError('not_found', 'Appareil introuvable');
    if (scope.isAdmin) return row;
    if (!(await scope.db.devices.hasWorkspace(row.id, scope.workspaceId))) {
        throw new FeatureError('forbidden', 'Cet appareil ne relève pas de cet espace');
    }
    return row;
}

/** Live presence for the given device ids (all false off a non-WS connection). */
export function online(ctx: FeatureContext, ids: string[]): Record<string, boolean> {
    return ctx.monitor?.isOnline(ids) ?? Object.fromEntries(ids.map((id) => [id, false]));
}

/** Map a row to the client shape, with live presence + computed self-update info. */
export async function toDevice(ctx: FeatureContext, row: DeviceRow): Promise<Device> {
    const [manifest, workspaceIds] = await Promise.all([
        readServedManifestCached(agentDistDir()),
        ctx.db.devices.workspaceIdsOf(row.id)
    ]);
    return deviceRowToDevice(
        row,
        online(ctx, [row.id])[row.id] ?? false,
        computeAgentUpdate(row, manifest),
        workspaceIds
    );
}

/**
 * Comme {@link authorizeDevice}, mais exige en plus que l'agent soit joignable :
 * pour les commandes qui ne font que relayer un ordre à la machine.
 */
export async function authorizeReachableDevice(ctx: FeatureContext, deviceId: string): Promise<DeviceRow> {
    const row = await authorizeDevice(ctx, deviceId);
    if (!(online(ctx, [row.id])[row.id] ?? false)) {
        throw new FeatureError('conflict', 'Agent hors ligne');
    }
    return row;
}

/**
 * Variante réservée à l'administrateur global, pour les actions de flotte qui
 * exigent un agent en ligne (mise à jour, arrêt/redémarrage du service).
 */
export async function authorizeOnlineDevice(ctx: FeatureContext, deviceId: string): Promise<DeviceRow> {
    ctx.assertAdmin();
    return authorizeReachableDevice(ctx, deviceId);
}
