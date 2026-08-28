import {
    deviceReportSchema,
    isNewerVersion,
    type AgentManifest,
    type Device,
    type DevicePlatform,
    type DeviceReport,
    type DeviceRow,
    type DeviceStatus,
    type ProcessCapture
} from '@deveye/types';
import { FeatureError, type SdkFeatureContext } from '@deveye/types/sdk/server';

import type { DevicesRepo } from './repo';

export type DevicesContext = SdkFeatureContext<DevicesRepo>;

/** Le droit `devices: write` de l'espace : ranger, régler la collecte, effacer des relevés. */
export const WRITE = { level: 'write' } as const;
/** L'administrateur global, en plus du droit de feature : les gestes de flotte. */
export const ADMIN = { admin: true } as const;

/**
 * De quel appareil parle-t-on, et m'est-il accessible ? Puis sa ligne entière.
 *
 * La garde est celle de l'app (`ctx.deveye.devices.authorize`, la fonction
 * `authorizeDevice` de `src/agent/authorize.ts`) : la ligne doit exister et
 * être partagée avec CET espace, l'administrateur global passant outre. Le
 * module ne la refait pas ; il relit ensuite la ligne par son dépôt, parce
 * que la façade ne révèle qu'un résumé (`SdkDevice`) et que la flotte a
 * besoin de tout (empreinte, cible de build, configuration, comptabilité de
 * suppression). Le *niveau* exigé (`read`, `write`, `admin`) est déclaré par
 * chaque commande dans son `access`, appliqué par le dispatcheur avant.
 */
export async function loadDevice(ctx: DevicesContext, deviceId: string): Promise<DeviceRow> {
    await ctx.deveye.devices.authorize(deviceId);
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
 * Resolve a device's self-update status against the served manifest. `available`
 * requires a known build target whose binary is both present *and signed* (no
 * signature ⇒ never self-updatable) and a served version that is **strictly newer**
 * than what's running, so a server lagging a running agent never offers a downgrade.
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
 * Map a persisted device row to the client-facing domain shape.
 *
 * Le même passage de ligne à `Device` que `src/agent/mappers.ts` fait pour
 * l'infrastructure (l'enrôlement, les commandes de transport `agent.*` qui
 * rendent l'appareil) : deux lecteurs d'un même schéma, tenus d'accord par
 * `deviceSchema`, que le dispatcheur valide en sortie.
 */
export function rowToDevice(row: DeviceRow, online: boolean, update: AgentUpdateInfo, workspaceIds: number[]): Device {
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

/** Une ligne, avec sa présence en direct, son état de mise à jour et ses espaces. */
export async function toDevice(ctx: DevicesContext, row: DeviceRow): Promise<Device> {
    const [manifest, workspaceIds] = await Promise.all([
        ctx.deveye.agents.servedManifest(),
        ctx.repo.devices.workspaceIdsOf(row.id)
    ]);
    return rowToDevice(row, ctx.deveye.devices.isOnline(row.id), computeAgentUpdate(row, manifest), workspaceIds);
}
