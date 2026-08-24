import {
    DEFAULT_METRIC_INTERVAL_SECONDS,
    DEFAULT_PROCESS_CAPTURE,
    DEFAULT_SENTINEL_INTEGRITY_MINUTES,
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
} from '@deveye/types';

/** Build the collection config the server pushes to an agent (defaults applied). */
export function deviceAgentConfig(row: DeviceRow): AgentConfigPayload {
    const metricSeconds = row.metric_interval_seconds ?? DEFAULT_METRIC_INTERVAL_SECONDS;
    const capture = (row.process_capture as ProcessCapture | null) ?? DEFAULT_PROCESS_CAPTURE;
    return {
        metricIntervalMs: metricSeconds * 1000,
        processCapture: capture,
        // Sentinelle éteinte, l'agent ne relève ni persistance ni
        // authentification. Ces deux sondes ne coûtent rien à qui ne les demande
        // pas, et une machine non surveillée ne doit pas voir ses journaux lus.
        sentinelEnabled: row.sentinel_enabled === 1,
        integrityIntervalMs: (row.sentinel_integrity_minutes ?? DEFAULT_SENTINEL_INTEGRITY_MINUTES) * 60_000,
        authEventsEnabled: row.sentinel_auth_events === 1
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
 *
 * `workspaceIds` vient de la table de jonction, que la ligne ne porte pas : les
 * appelants qui l'ont chargée la passent, les autres (enrôlement, où le partage
 * ne fait que naître) laissent la liste vide.
 */
export function deviceRowToDevice(
    row: DeviceRow,
    online: boolean,
    update: AgentUpdateInfo = { latest: null, available: false },
    workspaceIds: number[] = []
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
        processCapture: (row.process_capture as ProcessCapture | null) ?? null,
        retentionDays: row.retention_days === null ? null : Number(row.retention_days),
        workspaceIds,
        deleteError: row.delete_error ?? null
    };
}
