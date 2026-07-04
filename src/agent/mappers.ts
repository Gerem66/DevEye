import {
    deviceReportSchema,
    isNewerVersion,
    type AgentConfigPayload,
    type AgentManifest,
    type Device,
    type DeviceReport,
    type DeviceRow,
    type DevicePlatform,
    type DeviceStatus,
    type ProcessCapture
} from 'deveye-types';

/**
 * Server-side defaults applied when a device hasn't overridden a setting:
 * metrics every 30 s, a full snapshot (all processes) every 10 min, everything
 * kept 30 days (see `Env` for the retention defaults). Mirror any change in the
 * client's `ConfigDialog` DEFAULTS and the agent's bootstrap constants.
 */
export const DEFAULT_METRIC_INTERVAL_SECONDS = 30;
export const DEFAULT_SNAPSHOT_INTERVAL_SECONDS = 600;
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

/** Whether/where a device's agent can self-update, derived from the synced manifest. */
export interface AgentUpdateInfo {
    /** Version of the served binary set (manifest), or null when nothing is synced. */
    latest: string | null;
    /** A newer **signed** binary exists for the device's reported target. */
    available: boolean;
}

/**
 * Resolve a device's self-update status against the served manifest. `available`
 * requires a known build target whose binary is both present *and signed* (no
 * signature ⇒ never self-updatable) and a served version that is **strictly newer**
 * than what's running — so a server lagging a running agent never offers a downgrade.
 */
export function computeAgentUpdate(row: DeviceRow, manifest: AgentManifest | null): AgentUpdateInfo {
    if (!manifest) return { latest: null, available: false };
    const latest = manifest.version;
    if (!row.agent_target || !row.agent_version) return { latest, available: false };
    const target = manifest.targets.find((t) => t.id === row.agent_target);
    if (!target || !target.signature) return { latest, available: false };
    return { latest, available: isNewerVersion(latest, row.agent_version) };
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

/**
 * Map a persisted device row to the client-facing domain shape. `update` carries
 * the self-update status (from {@link computeAgentUpdate}); it defaults to "no
 * update" for call sites that don't have the manifest at hand (e.g. enrollment).
 */
export function deviceRowToDevice(
    row: DeviceRow,
    online: boolean,
    update: AgentUpdateInfo = { latest: null, available: false }
): Device {
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
        agentVersion: row.agent_version ?? null,
        latestAgentVersion: update.latest,
        agentUpdateAvailable: update.available,
        report: parseDeviceReport(row.report_json),
        metricIntervalSeconds: row.metric_interval_seconds === null ? null : Number(row.metric_interval_seconds),
        snapshotIntervalSeconds: row.snapshot_interval_seconds === null ? null : Number(row.snapshot_interval_seconds),
        processCapture: (row.process_capture as ProcessCapture | null) ?? null,
        retentionDays: row.retention_days === null ? null : Number(row.retention_days),
        processRetentionDays: row.process_retention_days === null ? null : Number(row.process_retention_days),
        deleteError: row.delete_error ?? null
    };
}
