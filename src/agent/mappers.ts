import type { Device, DeviceRow, DevicePlatform, DeviceStatus } from 'deveye-types';

/** Map a persisted device row to the client-facing domain shape. */
export function deviceRowToDevice(row: DeviceRow, online: boolean): Device {
    return {
        id: row.id,
        ownerId: row.owner_id,
        name: row.name,
        fingerprint: row.fingerprint,
        platform: row.platform as DevicePlatform,
        status: row.status as DeviceStatus,
        online,
        lastSeen: row.last_seen === null ? null : Number(row.last_seen),
        created: Number(row.created)
    };
}
