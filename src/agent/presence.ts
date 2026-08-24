import type { DeviceRow } from '@deveye/types';

import type { LiveHub } from '@/live/hub';
import type { Database } from '@/db';

/**
 * Presence *transitions* recorded around an agent socket's lifecycle.
 *
 * The `device_presence` table must only ever contain real edges (online ⇄
 * offline): the timeline renders its rows as alternating segments, so a
 * duplicated or spurious edge shows up as arbitrary green/dark stripes. The two
 * failure modes deduplicated here both come from fast reconnects:
 * - a *new* socket connecting while the previous one is still open must not
 *   re-record "online";
 * - the *old* socket's late close must not record "offline" while the device is
 *   in fact still online through its replacement socket (the caller checks the
 *   hub and only calls {@link recordAgentOffline} when the device really left).
 */

/**
 * Record the "agent online" edge for a fresh connection.
 *
 * No-op when the device was already online in this process (socket replaced by
 * a fast reconnect). When the DB still says "online" while this process does not
 * — the offline edge was lost to a server crash/restart — the stale span is
 * first closed at the device's last proof of life, so the downtime shows as
 * offline instead of silently extending the previous online span.
 */
export async function recordAgentOnline(db: Database, device: DeviceRow, wasOnlineInHub: boolean): Promise<void> {
    if (wasOnlineInHub) return;
    const now = Date.now();
    const dbOnline = await db.presence.onlineAt(device.id, now);
    if (dbOnline) {
        const lastSeenMs = device.last_seen === null ? now : Number(device.last_seen) * 1000;
        await db.presence.record(device.id, Math.min(lastSeenMs, now), false);
    }
    await db.presence.record(device.id, now, true);
}

/**
 * Record the "agent offline" edge. Call only once the hub confirms no live
 * socket remains for the device (see module doc).
 *
 * Le front est daté sur la **dernière preuve de vie** et non sur l'instant de la
 * découverte. Les deux coïncidaient tant qu'une déconnexion propre était le seul
 * chemin ; depuis que le balayage de vivacité rattrape les machines éteintes
 * sans un mot, dater sur `Date.now()` sur-déclarerait la disponibilité de tout
 * l'intervalle de balayage — jusqu'à une minute de vert qui n'a pas existé.
 * `devices.last_seen` est rafraîchi à chaque relevé : la donnée était là, rien
 * ne la lisait.
 */
export async function recordAgentOffline(db: Database, deviceId: string): Promise<void> {
    const now = Date.now();
    const row = await db.devices.findById(deviceId);
    const lastSeenMs = row?.last_seen === null || row?.last_seen === undefined ? now : Number(row.last_seen) * 1000;
    await db.presence.record(deviceId, Math.min(lastSeenMs, now), false);
}

/**
 * Avertit **tous** les espaces qui voient cet appareil qu'il vient de changer.
 *
 * Un appareil est partageable : ne prévenir que son espace d'appairage
 * laisserait tous les autres destinataires sur une présence figée jusqu'à leur
 * prochain rechargement. La liste vient de la table de jonction, seule autorité
 * sur « qui voit cette machine ».
 */
export async function notifyDeviceWorkspaces(db: Database, live: LiveHub, deviceId: string): Promise<void> {
    for (const workspaceId of await db.devices.workspaceIdsOf(deviceId)) {
        live.changed(workspaceId, ['devices'], null);
    }
}
