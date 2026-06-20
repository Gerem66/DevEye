import {
    deviceReportSchema,
    type Device,
    type DeviceReport,
    type DeviceRow,
    type DevicePlatform,
    type DeviceStatus
} from 'deveye-types';

/** Safely decode the stored JSON report; returns null on absence or corruption. */
export function parseDeviceReport(reportJson: string | null): DeviceReport | null {
    if (!reportJson) return null;
    try {
        const parsed = deviceReportSchema.safeParse(JSON.parse(reportJson));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

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
        created: Number(row.created),
        report: parseDeviceReport(row.report_json)
    };
}
