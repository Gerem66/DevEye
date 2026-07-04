import type { DeviceRow } from 'deveye-types';

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
 */
export async function recordAgentOffline(db: Database, deviceId: string): Promise<void> {
    await db.presence.record(deviceId, Date.now(), false);
}
