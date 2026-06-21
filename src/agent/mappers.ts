import {
    deviceReportSchema,
    type AgentConfigPayload,
    type Device,
    type DeviceReport,
    type DeviceRow,
    type DevicePlatform,
    type DeviceStatus,
    type ProcessCapture
} from 'deveye-types';

/** Server-side defaults applied when a device hasn't overridden a setting. */
export const DEFAULT_METRIC_INTERVAL_SECONDS = 10;
export const DEFAULT_SNAPSHOT_INTERVAL_SECONDS = 300;
export const DEFAULT_PROCESS_CAPTURE: ProcessCapture = 'all';

/** Build the collection config the server pushes to an agent (defaults applied). */
export function deviceAgentConfig(row: DeviceRow): AgentConfigPayload {
    const metricSeconds = row.metric_interval_seconds ?? DEFAULT_METRIC_INTERVAL_SECONDS;
    const snapshotSeconds = row.snapshot_interval_seconds ?? DEFAULT_SNAPSHOT_INTERVAL_SECONDS;
    const capture = (row.process_capture as ProcessCapture | null) ?? DEFAULT_PROCESS_CAPTURE;
    return {
        metricIntervalMs: metricSeconds * 1000,
        snapshotIntervalMs: snapshotSeconds * 1000,
        processCapture: capture
    };
}

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
        report: parseDeviceReport(row.report_json),
        metricIntervalSeconds: row.metric_interval_seconds === null ? null : Number(row.metric_interval_seconds),
        snapshotIntervalSeconds: row.snapshot_interval_seconds === null ? null : Number(row.snapshot_interval_seconds),
        processCapture: (row.process_capture as ProcessCapture | null) ?? null,
        retentionDays: row.retention_days === null ? null : Number(row.retention_days),
        processRetentionDays: row.process_retention_days === null ? null : Number(row.process_retention_days)
    };
}
