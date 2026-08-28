import type { Device, DeviceRow } from '@deveye/types';

import { FeatureError, type FeatureContext } from '@/features/_define';
import { computeAgentUpdate, deviceRowToDevice } from './mappers';
import { agentDistDir, readServedManifestCached } from './sync';

/**
 * Ce qu'il faut pour répondre à « cet appareil m'est-il visible ? » : la base,
 * l'espace visé et le statut d'administrateur global. Un `FeatureContext` le
 * porte ; la façade du SDK (`features/_sdk/facade.ts`) aussi, sans session ni
 * socket, et c'est pour elle que la garde ne demande rien de plus.
 */
export type DeviceScope = Pick<FeatureContext, 'db' | 'isAdmin' | 'workspaceId'>;

/**
 * Charge un appareil que l'appelant a le droit d'atteindre, sinon lève.
 *
 * La frontière est **le partage** : un appareil se gère depuis n'importe quel
 * espace avec lequel il est partagé (`device_workspaces`), pas seulement depuis
 * celui où il a été appairé. C'est la seule définition de « cet appareil m'est
 * accessible » ; le transport (`agent.*`), la feature (`devices.*`) et la
 * façade du SDK passent tous par elle.
 *
 * Deux dérogations, et pas une de plus :
 * - l'administrateur global, parce que la page Appareils gère la flotte entière,
 *   y compris des machines d'espaces dont il n'est pas membre ;
 * - son espace **personnel**, où tous les appareils sont disponibles en
 *   permanence sans partage explicite : l'accueil d'un admin est sa vue de
 *   flotte.
 *
 * Le *niveau* de droit exigé (`devices: read` ou `write`, `admin`) n'est pas
 * décidé ici : chaque commande le déclare dans son `access`, appliqué par le
 * dispatcheur avant que le handler ne tourne. Cette fonction ne répond qu'à la
 * question « de quel appareil parle-t-on, et m'est-il visible ? ».
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
