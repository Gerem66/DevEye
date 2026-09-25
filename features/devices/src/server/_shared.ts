import {
    deviceReportSchema,
    isNewerVersion,
    type AgentManifest,
    type DevicePlatform,
    type DeviceReport,
    type DeviceRow,
    type DeviceStatus,
    type ProcessCapture
} from '@deveye/types';
import { FeatureError, type SdkFeatureContext } from '@deveye/types/sdk/server';

import type { FleetDevice } from '../contracts/commands';
import type { DevicesRepo } from './repo';

export type DevicesContext = SdkFeatureContext<DevicesRepo>;

/** Le droit `devices: write` de l'espace : ranger, régler la collecte, effacer des relevés. */
export const WRITE = { level: 'write' } as const;
/**
 * M'est-il accessible, et à ce niveau ? Deux gardes, et il faut les deux : celle
 * de l'app (`ctx.deveye.devices.authorize` : la ligne habite cet espace ou y est
 * projetée) et la restriction que le rôle de l'appelant porte sur CETTE ligne.
 */
export async function assertDevice(
    ctx: DevicesContext,
    deviceId: string,
    level: 'read' | 'write' = 'read'
): Promise<void> {
    await ctx.deveye.devices.authorize(deviceId);
    await ctx.items.assert(deviceId, level);
}

/**
 * De quel appareil parle-t-on, et m'est-il accessible ? Puis sa ligne entière,
 * relue par le dépôt parce que la façade ne révèle qu'un résumé.
 */
export async function loadDevice(
    ctx: DevicesContext,
    deviceId: string,
    level: 'read' | 'write' = 'read'
): Promise<DeviceRow> {
    await assertDevice(ctx, deviceId, level);
    const row = await ctx.repo.devices.findById(deviceId);
    if (!row) throw new FeatureError('not_found', 'Appareil introuvable');
    return row;
}

/** Whether/where a device's agent can self-update, derived from the served manifest. */
export interface AgentUpdateInfo {
    /** Version of the served binary set (manifest), or null when nothing is synced. */
    latest: string | null;
    /** A newer **signed** binary exists for the device's reported target. */
    available: boolean;
}

/**
 * Resolve a device's self-update status against the served manifest.
 * `available` requires a signed binary for the device's build target and a
 * served version strictly newer than what's running (never a downgrade).
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
 * Map a persisted device row to the client-facing domain shape. Le même passage
 * que `src/agent/mappers.ts` fait pour l'infrastructure : deux lecteurs d'un
 * même schéma, tenus d'accord par `deviceSchema`.
 */
export function rowToDevice(
    row: DeviceRow,
    online: boolean,
    update: AgentUpdateInfo,
    foreign: boolean,
    planPaused: boolean
): FleetDevice {
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
        terminalDefaultUser: row.terminal_default_user ?? null,
        terminalCloseOnExit: row.terminal_close_on_exit !== 0,
        foreign,
        deleteError: row.delete_error ?? null,
        planPaused
    };
}

/** Une ligne, avec sa présence en direct, son état de mise à jour, son origine et sa pause d'offre. */
export async function toDevice(ctx: DevicesContext, row: DeviceRow): Promise<FleetDevice> {
    const manifest = await ctx.deveye.agents.servedManifest();
    return rowToDevice(
        row,
        ctx.deveye.devices.isOnline(row.id),
        computeAgentUpdate(row, manifest),
        row.workspace_id !== ctx.workspaceId,
        ctx.quota.isPaused('agents', row.id)
    );
}
