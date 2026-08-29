import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { z, ZodType } from 'zod';

import type { AgentManifest, DeviceRow, MetricSeriesPoint, PresenceEvent, ProcessSample } from '@deveye/types';
import {
    FeatureError,
    type SdkDevice,
    type SdkFeatureContext,
    type SdkWorkspaceSummary
} from '@deveye/types/sdk/server';
import { createTestContext, testDevice, type TestContext } from '@deveye/types/sdk/testing';

import {
    devicesAvailability,
    devicesCancelDelete,
    devicesCommands,
    devicesConfirm,
    devicesDelete,
    devicesDeleteSnapshots,
    devicesForceDelete,
    devicesLinkCodeCreate,
    devicesLinkCodeList,
    devicesLinkCodeRevoke,
    devicesLinkCodeSetAutoApprove,
    devicesList,
    devicesMetrics,
    devicesPresence,
    devicesProcessesAt,
    devicesReactivate,
    devicesRename,
    devicesReorder,
    devicesRequestDelete,
    devicesRevoke,
    devicesSetConfig,
    devicesSetSnapshotsPinned,
    devicesSetWorkspaces,
    devicesSnapshots,
    devicesStorage,
    devicesWorkspaceList
} from '../contracts/commands';
import type { DevicesRepo, LinkCode } from './repo';

/**
 * Les handlers du module, sur le harnais du SDK : les deux portées de la
 * liste, les ordres au hub que chaque geste de flotte donne, le partage entre
 * espaces, les codes de liaison, l'historique et la table des accès.
 *
 * `LINK_CODE_TTL_SECONDS` est posée AVANT le chargement des handlers, parce
 * que `env.ts` lit l'environnement à l'import : d'où l'import dynamique.
 */

process.env.LINK_CODE_TTL_SECONDS = '120';
delete process.env.MONITORING_RETENTION_DAYS;
const { devicesHandlers } = await import('./handlers');
const { computeAgentUpdate } = await import('./_shared');

/** Le handler d'un contrat, typé par ce contrat (le registre est hétérogène). */
function handlerFor<C extends { command: string; input: ZodType; output: ZodType }>(contract: C) {
    const def = devicesHandlers.find((h) => h.command === contract.command);
    assert.ok(def, `handler ${contract.command} manquant`);
    return def.handler as (
        ctx: SdkFeatureContext<DevicesRepo>,
        input: z.output<C['input']>
    ) => Promise<z.input<C['output']>>;
}

const failsWith =
    (code: FeatureError['code']) =>
    (e: unknown): boolean =>
        e instanceof FeatureError && e.code === code;

const DEVICE_A = '11111111-1111-4111-8111-111111111111';
const DEVICE_B = '22222222-2222-4222-8222-222222222222';
const DEVICE_C = '33333333-3333-4333-8333-333333333333';
const UNKNOWN = '99999999-9999-4999-8999-999999999999';

const DAY_MS = 86_400_000;

/** Une ligne appareil, telle que le vrai dépôt la rendrait. */
function row(over: Partial<DeviceRow> & { id: string }): DeviceRow {
    return {
        owner_id: 1,
        workspace_id: 1,
        name: `Machine ${over.id.slice(0, 1)}`,
        fingerprint: `fp-${over.id.slice(0, 8)}`,
        platform: 'linux',
        status: 'active',
        public_key: null,
        token_hash: 'hash',
        last_seen: null,
        created: 1000,
        agent_version: null,
        agent_target: null,
        report_json: null,
        metric_interval_seconds: null,
        process_capture: null,
        retention_days: null,
        status_before_delete: null,
        delete_error: null,
        ...over
    };
}

function point(ts: number): MetricSeriesPoint {
    return {
        timestamp: ts,
        cpuPercent: 1,
        memUsedBytes: 1,
        memTotalBytes: 2,
        diskUsedBytes: 1,
        diskTotalBytes: 2,
        netRxBytes: 0,
        netTxBytes: 0,
        usersCount: 1,
        loadAvg1: null,
        cpuTempC: null,
        uptimeSeconds: null,
        processCount: null,
        activeConnections: null,
        gpuPercent: null,
        diskReadBytes: null,
        diskWriteBytes: null,
        batteryPercent: null,
        batteryCharging: null
    };
}

interface StoredCode {
    code: string;
    user_id: number;
    workspace_id: number;
    expires_at: number | null;
    used_at: number | null;
    auto_approve: boolean;
}

interface StoredInstant {
    ts: number;
    pinned: boolean;
}

interface StoredSample extends StoredInstant {
    processes: number;
    bytes: number;
}

interface FakeRepo extends DevicesRepo {
    deviceRows: DeviceRow[];
    /** La jonction `device_workspaces` : appareil → espaces qui y ont accès. */
    shares: Map<string, number[]>;
    codes: StoredCode[];
    /** L'historique d'UN appareil (les tests d'historique n'en regardent qu'un). */
    points: StoredInstant[];
    presenceEvents: PresenceEvent[];
    samples: StoredSample[];
    /** Les appels sans état à relire : rangement, purges, avec leurs arguments. */
    calls: string[];
}

/**
 * Un dépôt en mémoire, même contrat que le vrai ; les purges globales ne font
 * que se consigner. Les lignes rendues sont des copies, comme une lecture SQL.
 */
function fakeRepo(deviceRows: DeviceRow[], shares: Record<string, number[]> = {}): FakeRepo {
    let seq = 0;
    const shareMap = new Map(Object.entries(shares));
    const codes: StoredCode[] = [];
    const points: StoredInstant[] = [];
    const presenceEvents: PresenceEvent[] = [];
    const samples: StoredSample[] = [];
    const calls: string[] = [];
    const copy = (r: DeviceRow | undefined): DeviceRow | null => (r ? { ...r } : null);
    const find = (id: string) => deviceRows.find((r) => r.id === id);
    const now = () => Math.floor(Date.now() / 1000);
    const activeCode = (userId: number, code: string) =>
        codes.find(
            (c) =>
                c.code === code &&
                c.user_id === userId &&
                c.used_at === null &&
                (c.expires_at === null || c.expires_at > now())
        );
    const toLinkCode = (c: StoredCode): LinkCode => ({
        code: c.code,
        expiresAt: c.expires_at,
        autoApprove: c.auto_approve
    });
    const inRange = (from: number, to: number) => (i: StoredInstant) => i.ts >= from && i.ts <= to;
    const expired = (days: number) => (i: StoredInstant) => !i.pinned && i.ts < Date.now() - days * DAY_MS;

    return {
        deviceRows,
        shares: shareMap,
        codes,
        points,
        presenceEvents,
        samples,
        calls,
        devices: {
            findById: async (id) => copy(find(id)),
            findByIds: async (ids) => ids.flatMap((id) => copy(find(id)) ?? []),
            listAll: async () => [...deviceRows].sort((a, b) => b.created - a.created).map((r) => ({ ...r })),
            async setStatus(id, status) {
                const r = find(id);
                if (r) r.status = status;
            },
            async rename(id, name) {
                const r = find(id);
                if (r) r.name = name;
            },
            async setConfig(id, patch) {
                const r = find(id);
                if (!r) return;
                if (patch.metricIntervalSeconds !== undefined) r.metric_interval_seconds = patch.metricIntervalSeconds;
                if (patch.processCapture !== undefined) r.process_capture = patch.processCapture;
                if (patch.retentionDays !== undefined) r.retention_days = patch.retentionDays;
            },
            async requestDeletion(id, currentStatus) {
                const r = find(id);
                if (!r) return;
                r.status = 'pending_deletion';
                r.status_before_delete = currentStatus;
                r.delete_error = null;
            },
            async cancelDeletion(id) {
                const r = find(id);
                if (!r || r.status !== 'pending_deletion') return;
                r.status = (r.status_before_delete as DeviceRow['status'] | null) ?? 'active';
                r.status_before_delete = null;
                r.delete_error = null;
            },
            async archive(id) {
                const r = find(id);
                if (!r) return;
                r.status = 'archived';
                r.token_hash = '';
                r.status_before_delete = null;
                r.delete_error = null;
            },
            async delete(id) {
                const index = deviceRows.findIndex((r) => r.id === id);
                if (index === -1) return false;
                deviceRows.splice(index, 1);
                shareMap.delete(id);
                return true;
            },
            async reorder(workspaceId, ids) {
                calls.push(`reorder:${workspaceId}:${ids.join(',')}`);
            },
            workspaceIdsOf: async (id) => [...(shareMap.get(id) ?? [])],
            workspaceIdsFor: async (ids) => new Map(ids.map((id) => [id, [...(shareMap.get(id) ?? [])]])),
            async setWorkspaces(id, workspaceIds) {
                shareMap.set(id, [...workspaceIds]);
            }
        },
        linkCodes: {
            async create({ userId, workspaceId, ttlSeconds, autoApprove }) {
                const created: StoredCode = {
                    code: `CODE-${++seq}`,
                    user_id: userId,
                    workspace_id: workspaceId,
                    expires_at: ttlSeconds === null ? null : now() + ttlSeconds,
                    used_at: null,
                    auto_approve: autoApprove
                };
                codes.push(created);
                return toLinkCode(created);
            },
            listActive: async (userId) =>
                codes
                    .filter((c) => c.user_id === userId && c.used_at === null)
                    .filter((c) => c.expires_at === null || c.expires_at > now())
                    .map(toLinkCode),
            async setAutoApprove(userId, code, autoApprove) {
                const target = activeCode(userId, code);
                if (!target) return null;
                target.auto_approve = autoApprove;
                return toLinkCode(target);
            },
            async revoke(userId, code) {
                const index = codes.findIndex((c) => c.code === code && c.user_id === userId && c.used_at === null);
                if (index === -1) return false;
                codes.splice(index, 1);
                return true;
            }
        },
        metrics: {
            async query({ deviceId, from, to, resolution }) {
                calls.push(`metrics.query:${deviceId}:${resolution}`);
                return points.filter(inRange(from, to)).map((p) => point(p.ts));
            },
            availableDays: async (_deviceId, tzOffsetMinutes) => [
                ...new Set(points.map((p) => new Date(p.ts - tzOffsetMinutes * 60_000).toISOString().slice(0, 10)))
            ],
            async instantTimes(_deviceId, from, to) {
                const kept = points.filter(inRange(from, to));
                return {
                    timestamps: kept.map((p) => p.ts),
                    pinned: kept.filter((p) => p.pinned).map((p) => p.ts),
                    truncated: false
                };
            },
            async setInstantsPinned(_deviceId, from, to, pinned) {
                const kept = points.filter(inRange(from, to));
                for (const p of kept) p.pinned = pinned;
                for (const s of samples.filter(inRange(from, to))) s.pinned = pinned;
                return kept.length;
            },
            async deleteExpiredInRange(_deviceId, from, to, defaultDays) {
                calls.push(`metrics.expire:${defaultDays}`);
                const gone = points.filter(inRange(from, to)).filter(expired(defaultDays));
                for (const g of gone) points.splice(points.indexOf(g), 1);
                return gone.length;
            },
            async pruneByRetention(defaultDays) {
                calls.push(`metrics.prune:${defaultDays}`);
                return 0;
            }
        },
        presence: {
            query: async (_deviceId, from, to) => presenceEvents.filter((e) => e.ts >= from && e.ts <= to),
            async onlineAt(_deviceId, at) {
                const last = [...presenceEvents].reverse().find((e) => e.ts <= at);
                return last?.online ?? false;
            },
            async pruneByRetention(defaultDays) {
                calls.push(`presence.prune:${defaultDays}`);
                return 0;
            }
        },
        processSamples: {
            async nearest(_deviceId, at): Promise<ProcessSample | null> {
                const best = [...samples].sort((a, b) => Math.abs(a.ts - at) - Math.abs(b.ts - at))[0];
                if (!best || Math.abs(best.ts - at) > 5 * 60_000) return null;
                return { ts: best.ts, kind: 'all', processes: [] };
            },
            async snapshotTimes(_deviceId, from, to) {
                const kept = samples.filter(inRange(from, to));
                return { timestamps: kept.map((s) => s.ts), pinned: kept.filter((s) => s.pinned).map((s) => s.ts) };
            },
            storage: async () => ({
                snapshots: samples.length,
                processes: samples.reduce((n, s) => n + s.processes, 0),
                bytes: samples.reduce((n, s) => n + s.bytes, 0)
            }),
            async deleteRange(_deviceId, from, to) {
                const gone = samples.filter(inRange(from, to));
                for (const g of gone) samples.splice(samples.indexOf(g), 1);
                return { snapshots: gone.length };
            },
            async deleteExpiredInRange(_deviceId, from, to, defaultDays) {
                calls.push(`samples.expire:${defaultDays}`);
                const gone = samples.filter(inRange(from, to)).filter(expired(defaultDays));
                for (const g of gone) samples.splice(samples.indexOf(g), 1);
                return { snapshots: gone.length };
            },
            async pruneByRetention(defaultDays) {
                calls.push(`samples.prune:${defaultDays}`);
                return 0;
            }
        }
    };
}

interface CtxOverrides {
    isAdmin?: boolean;
    kind?: 'personal' | 'shared';
    userId?: number;
    workspaceId?: number;
    workspaces?: readonly SdkWorkspaceSummary[];
    /** Ce que la façade révèle ; par défaut, chaque ligne du dépôt, A seule en ligne. */
    devices?: readonly SdkDevice[];
}

function contextFor(repo: FakeRepo, over: CtxOverrides = {}): TestContext<DevicesRepo> {
    return createTestContext<DevicesRepo>({
        repo,
        devices:
            over.devices ??
            repo.deviceRows.map((r) =>
                testDevice({ id: r.id, name: r.name, online: r.id === DEVICE_A, status: r.status })
            ),
        ...over
    });
}

/** Trois appareils : A et B actifs, C archivé, du plus ancien au plus récent. */
function fleet(): FakeRepo {
    return fakeRepo(
        [
            row({ id: DEVICE_A, created: 1000 }),
            row({ id: DEVICE_B, created: 2000 }),
            row({ id: DEVICE_C, created: 3000, status: 'archived', token_hash: '' })
        ],
        { [DEVICE_A]: [1, 2], [DEVICE_B]: [1], [DEVICE_C]: [1] }
    );
}

const agentOrders = (ctx: TestContext<DevicesRepo>, method: string) =>
    ctx.recorded.agentRequests.filter((r) => r.method === method).map((r) => r.deviceId);

describe('devices.list', () => {
    it("la portée d'espace suit la façade : ses appareils, dans son ordre, avec leurs espaces et leur présence", async () => {
        const repo = fleet();
        // La façade rend B avant A : c'est le rang de l'espace, pas la date.
        const ctx = contextFor(repo, {
            devices: [testDevice({ id: DEVICE_B, online: false }), testDevice({ id: DEVICE_A, online: true })]
        });
        const out = await handlerFor(devicesList)(ctx, {});
        devicesList.output.parse(out);
        assert.deepEqual(
            out.devices.map((d) => d.id),
            [DEVICE_B, DEVICE_A]
        );
        assert.equal(out.devices[0].online, false);
        assert.equal(out.devices[1].online, true);
        assert.deepEqual(out.devices[1].workspaceIds, [1, 2]);
        // Rien de synchronisé : aucune mise à jour à proposer.
        assert.equal(out.devices[1].latestAgentVersion, null);
        assert.equal(out.devices[1].agentUpdateAvailable, false);
    });

    it("la flotte : l'administrateur voit tout, du plus récent au plus ancien, archivés compris", async () => {
        const repo = fleet();
        const ctx = contextFor(repo, { isAdmin: true, kind: 'shared', devices: [] });
        const out = await handlerFor(devicesList)(ctx, { scope: 'fleet' });
        assert.deepEqual(
            out.devices.map((d) => [d.id, d.status]),
            [
                [DEVICE_C, 'archived'],
                [DEVICE_B, 'active'],
                [DEVICE_A, 'active']
            ]
        );
    });

    it("la flotte est refusée à qui n'est pas administrateur", async () => {
        const ctx = contextFor(fleet());
        await assert.rejects(handlerFor(devicesList)(ctx, { scope: 'fleet' }), failsWith('forbidden'));
    });

    it("la mise à jour de l'agent : un binaire signé, strictement plus récent, pour la cible déclarée", () => {
        const manifest: AgentManifest = {
            version: '2.0.0',
            targets: [
                { id: 'linux-x86_64', filename: 'a', sha256: 'a'.repeat(64), size: 1, signature: 'sig' },
                { id: 'macos-arm64', filename: 'b', sha256: 'b'.repeat(64), size: 1 }
            ]
        };
        const linux = row({ id: DEVICE_A, agent_target: 'linux-x86_64', agent_version: '1.0.0' });
        assert.deepEqual(computeAgentUpdate(linux, manifest), { latest: '2.0.0', available: true });
        assert.deepEqual(computeAgentUpdate({ ...linux, agent_version: '2.0.0' }, manifest), {
            latest: '2.0.0',
            available: false
        });
        // Une cible sans signature ne se met jamais à jour d'elle-même.
        assert.deepEqual(computeAgentUpdate({ ...linux, agent_target: 'macos-arm64' }, manifest), {
            latest: '2.0.0',
            available: false
        });
        assert.deepEqual(computeAgentUpdate({ ...linux, agent_version: null }, manifest), {
            latest: '2.0.0',
            available: false
        });
        assert.deepEqual(computeAgentUpdate(linux, null), { latest: null, available: false });
    });
});

describe("le cycle de vie d'un appareil", () => {
    it("l'approbation active l'appareil et remet sa session agent à zéro", async () => {
        const repo = fakeRepo([row({ id: DEVICE_A, status: 'pending' })], { [DEVICE_A]: [1] });
        const ctx = contextFor(repo, { isAdmin: true });
        const out = await handlerFor(devicesConfirm)(ctx, { deviceId: DEVICE_A });
        devicesConfirm.output.parse(out);
        assert.equal(out.device.status, 'active');
        assert.equal(repo.deviceRows[0].status, 'active');
        assert.deepEqual(agentOrders(ctx, 'resetAgentSession'), [DEVICE_A]);
        assert.deepEqual(
            ctx.recorded.audits.map((a) => a.action),
            ['devices.confirm']
        );
    });

    it("un appareil révoqué ne s'approuve pas : il se réactive", async () => {
        const repo = fakeRepo([row({ id: DEVICE_A, status: 'revoked' })]);
        const ctx = contextFor(repo, { isAdmin: true });
        await assert.rejects(handlerFor(devicesConfirm)(ctx, { deviceId: DEVICE_A }), failsWith('conflict'));
        assert.deepEqual(ctx.recorded.agentRequests, []);
    });

    it('la révocation coupe la session agent tout de suite', async () => {
        const repo = fakeRepo([row({ id: DEVICE_A })]);
        const ctx = contextFor(repo, { isAdmin: true });
        const out = await handlerFor(devicesRevoke)(ctx, { deviceId: DEVICE_A });
        assert.equal(out.device.status, 'revoked');
        assert.deepEqual(agentOrders(ctx, 'disconnectAgent'), [DEVICE_A]);
    });

    it("la réactivation n'accepte qu'un appareil révoqué, et remet la session à zéro", async () => {
        const repo = fakeRepo([row({ id: DEVICE_A }), row({ id: DEVICE_B, status: 'revoked' })]);
        const ctx = contextFor(repo, { isAdmin: true });
        await assert.rejects(handlerFor(devicesReactivate)(ctx, { deviceId: DEVICE_A }), failsWith('conflict'));
        const out = await handlerFor(devicesReactivate)(ctx, { deviceId: DEVICE_B });
        assert.equal(out.device.status, 'active');
        assert.deepEqual(agentOrders(ctx, 'resetAgentSession'), [DEVICE_B]);
    });

    it('le renommage écrit le nom et le journalise', async () => {
        const repo = fakeRepo([row({ id: DEVICE_A, name: 'Ancien' })]);
        const ctx = contextFor(repo, { isAdmin: true });
        const out = await handlerFor(devicesRename)(ctx, { deviceId: DEVICE_A, name: 'Nouveau' });
        assert.equal(out.device.name, 'Nouveau');
        assert.equal(repo.deviceRows[0].name, 'Nouveau');
        assert.match(ctx.recorded.audits[0].description, /« Ancien » → « Nouveau »/);
    });

    it('un appareil inconnu du dépôt est introuvable', async () => {
        const ctx = contextFor(fakeRepo([]), { isAdmin: true });
        await assert.rejects(handlerFor(devicesRename)(ctx, { deviceId: UNKNOWN, name: 'x' }), failsWith('not_found'));
    });

    it("la suppression gérée mémorise le statut, demande l'auto-destruction, et ne se demande qu'une fois", async () => {
        const repo = fakeRepo([row({ id: DEVICE_A })]);
        const ctx = contextFor(repo, { isAdmin: true });
        const out = await handlerFor(devicesRequestDelete)(ctx, { deviceId: DEVICE_A });
        assert.equal(out.device.status, 'pending_deletion');
        assert.equal(repo.deviceRows[0].status_before_delete, 'active');
        assert.deepEqual(agentOrders(ctx, 'requestDestroy'), [DEVICE_A]);
        // Le harnais répond « en ligne » : pas de mention d'attente.
        assert.doesNotMatch(ctx.recorded.audits[0].description, /en attente/);
        await assert.rejects(handlerFor(devicesRequestDelete)(ctx, { deviceId: DEVICE_A }), failsWith('conflict'));
    });

    it("l'annulation restaure le statut mémorisé", async () => {
        const repo = fakeRepo([row({ id: DEVICE_A, status: 'pending_deletion', status_before_delete: 'pending' })]);
        const ctx = contextFor(repo, { isAdmin: true });
        const out = await handlerFor(devicesCancelDelete)(ctx, { deviceId: DEVICE_A });
        assert.equal(out.device.status, 'pending');
        assert.equal(repo.deviceRows[0].status_before_delete, null);
    });

    it("la suppression forcée archive sans auto-destruction, coupe la session, et ne s'applique qu'une fois", async () => {
        const repo = fakeRepo([row({ id: DEVICE_A })]);
        const ctx = contextFor(repo, { isAdmin: true });
        const out = await handlerFor(devicesForceDelete)(ctx, { deviceId: DEVICE_A });
        assert.equal(out.device.status, 'archived');
        assert.equal(repo.deviceRows[0].token_hash, '');
        assert.deepEqual(agentOrders(ctx, 'disconnectAgent'), [DEVICE_A]);
        assert.deepEqual(agentOrders(ctx, 'requestDestroy'), []);
        await assert.rejects(handlerFor(devicesForceDelete)(ctx, { deviceId: DEVICE_A }), failsWith('conflict'));
    });

    it("la purge dure efface la ligne sans rien demander à l'agent", async () => {
        const repo = fakeRepo([row({ id: DEVICE_A })], { [DEVICE_A]: [1, 2] });
        const ctx = contextFor(repo, { isAdmin: true });
        const out = await handlerFor(devicesDelete)(ctx, { deviceId: DEVICE_A });
        assert.deepEqual(out, { deviceId: DEVICE_A });
        assert.deepEqual(repo.deviceRows, []);
        assert.deepEqual(ctx.recorded.agentRequests, []);
        assert.deepEqual(ctx.recorded.audits, [
            { action: 'devices.delete', description: 'Appareil et données supprimés : « Machine 1 »' }
        ]);
    });
});

describe('la configuration de collecte et le rangement', () => {
    it('une cadence changée se pousse à un agent en ligne', async () => {
        const repo = fakeRepo([row({ id: DEVICE_A })]);
        const ctx = contextFor(repo);
        const out = await handlerFor(devicesSetConfig)(ctx, { deviceId: DEVICE_A, metricIntervalSeconds: 30 });
        assert.equal(out.device.metricIntervalSeconds, 30);
        assert.equal(repo.deviceRows[0].metric_interval_seconds, 30);
        assert.deepEqual(agentOrders(ctx, 'pushConfig'), [DEVICE_A]);
        assert.equal(ctx.recorded.audits[0].action, 'devices.setConfig');
    });

    it("la conservation ne concerne que le serveur : rien n'est poussé, et `null` rend le défaut", async () => {
        const repo = fakeRepo([row({ id: DEVICE_A, retention_days: 90 })]);
        const ctx = contextFor(repo);
        const out = await handlerFor(devicesSetConfig)(ctx, { deviceId: DEVICE_A, retentionDays: 7 });
        assert.equal(out.device.retentionDays, 7);
        assert.deepEqual(agentOrders(ctx, 'pushConfig'), []);
        const reset = await handlerFor(devicesSetConfig)(ctx, { deviceId: DEVICE_A, retentionDays: null });
        assert.equal(reset.device.retentionDays, null);
    });

    it("le rangement vise l'espace actif, dans l'ordre donné", async () => {
        const repo = fakeRepo([row({ id: DEVICE_A }), row({ id: DEVICE_B })]);
        const ctx = contextFor(repo, { workspaceId: 4 });
        const out = await handlerFor(devicesReorder)(ctx, { ids: [DEVICE_B, DEVICE_A] });
        assert.deepEqual(out.ids, [DEVICE_B, DEVICE_A]);
        assert.deepEqual(repo.calls, [`reorder:4:${DEVICE_B},${DEVICE_A}`]);
    });
});

const WORKSPACES: SdkWorkspaceSummary[] = [
    { id: 1, name: 'Moi', kind: 'personal', ownerUserId: 1 },
    { id: 2, name: 'Équipe', kind: 'shared', ownerUserId: 1 },
    { id: 3, name: 'Labo', kind: 'shared', ownerUserId: 9 },
    { id: 4, name: 'Autrui', kind: 'personal', ownerUserId: 9 }
];

describe('le partage entre espaces', () => {
    it("les espaces proposés sont les partagés plus l'espace d'appairage, avec leur état", async () => {
        const repo = fakeRepo([row({ id: DEVICE_A, workspace_id: 1 })], { [DEVICE_A]: [1, 3] });
        const ctx = contextFor(repo, { isAdmin: true, workspaces: WORKSPACES });
        const out = await handlerFor(devicesWorkspaceList)(ctx, { deviceId: DEVICE_A });
        assert.equal(out.originWorkspaceId, 1);
        assert.deepEqual(
            out.workspaces.map((w) => [w.id, w.shared]),
            [
                [1, true],
                [2, false],
                [3, true]
            ]
        );
    });

    it("un espace inconnu est ignoré, l'espace d'appairage réintégré d'office, et le changement journalisé", async () => {
        const repo = fakeRepo([row({ id: DEVICE_A, workspace_id: 1 })], { [DEVICE_A]: [1, 3] });
        const ctx = contextFor(repo, { isAdmin: true, workspaces: WORKSPACES });
        const out = await handlerFor(devicesSetWorkspaces)(ctx, { deviceId: DEVICE_A, workspaceIds: [2, 99] });
        assert.deepEqual([...repo.shares.get(DEVICE_A)!].sort(), [1, 2]);
        assert.deepEqual([...devicesSetWorkspaces.output.parse(out).device.workspaceIds].sort(), [1, 2]);
        assert.equal(ctx.recorded.audits.length, 1);
        assert.match(ctx.recorded.audits[0].description, /2 espace\(s\)/);
    });

    it("un partage inchangé n'écrit pas de ligne de journal", async () => {
        const repo = fakeRepo([row({ id: DEVICE_A, workspace_id: 1 })], { [DEVICE_A]: [1, 2] });
        const ctx = contextFor(repo, { isAdmin: true, workspaces: WORKSPACES });
        await handlerFor(devicesSetWorkspaces)(ctx, { deviceId: DEVICE_A, workspaceIds: [1, 2] });
        assert.deepEqual(ctx.recorded.audits, []);
    });
});

describe('les codes de liaison', () => {
    it("un code s'émet dans l'espace actif, sous la durée de l'environnement, et se journalise sans sa valeur", async () => {
        const repo = fakeRepo([]);
        const ctx = contextFor(repo, { isAdmin: true, workspaceId: 2 });
        const before = Math.floor(Date.now() / 1000);
        const out = await handlerFor(devicesLinkCodeCreate)(ctx, { autoApprove: false });
        devicesLinkCodeCreate.output.parse(out);
        assert.equal(repo.codes[0].workspace_id, 2);
        assert.equal(repo.codes[0].user_id, 1);
        assert.ok(out.expiresAt !== null && out.expiresAt >= before + 120 && out.expiresAt <= before + 121);
        assert.equal(ctx.recorded.audits[0].action, 'devices.linkCodeCreate');
        assert.doesNotMatch(ctx.recorded.audits[0].description, /CODE-/);
    });

    it("un espace explicite doit exister : n'importe lequel de la liste, comme pour le partage ; un id absent est introuvable", async () => {
        const repo = fakeRepo([]);
        const ctx = contextFor(repo, { isAdmin: true, workspaceId: 1, workspaces: WORKSPACES });
        // L'espace 3 appartient à un autre compte : listé, donc accepté.
        const listed = await handlerFor(devicesLinkCodeCreate)(ctx, {
            autoApprove: true,
            ttlSeconds: null,
            workspaceId: 3
        });
        assert.equal(listed.expiresAt, null);
        assert.equal(listed.autoApprove, true);
        assert.equal(repo.codes[0].workspace_id, 3);
        await assert.rejects(
            handlerFor(devicesLinkCodeCreate)(ctx, { autoApprove: false, workspaceId: 99 }),
            failsWith('not_found')
        );
        assert.equal(repo.codes.length, 1);
    });

    it('la liste ne rend que les codes encore valables de leur émetteur', async () => {
        const repo = fakeRepo([]);
        const now = Math.floor(Date.now() / 1000);
        repo.codes.push(
            { code: 'MINE-OK1', user_id: 1, workspace_id: 1, expires_at: null, used_at: null, auto_approve: false },
            { code: 'MINE-USED', user_id: 1, workspace_id: 1, expires_at: null, used_at: now, auto_approve: false },
            { code: 'MINE-OLD', user_id: 1, workspace_id: 1, expires_at: now - 1, used_at: null, auto_approve: false },
            { code: 'THEIRS', user_id: 2, workspace_id: 1, expires_at: null, used_at: null, auto_approve: false }
        );
        const out = await handlerFor(devicesLinkCodeList)(contextFor(repo, { isAdmin: true }), {});
        assert.deepEqual(
            out.codes.map((c) => c.code),
            ['MINE-OK1']
        );
    });

    it("l'auto-approbation se retouche sur un code saisi à la main, comparé en majuscules", async () => {
        const repo = fakeRepo([]);
        repo.codes.push({
            code: 'ABCD-EFGH',
            user_id: 1,
            workspace_id: 1,
            expires_at: null,
            used_at: null,
            auto_approve: false
        });
        const ctx = contextFor(repo, { isAdmin: true });
        const out = await handlerFor(devicesLinkCodeSetAutoApprove)(ctx, { code: ' abcd-efgh ', autoApprove: true });
        assert.deepEqual(out, { code: 'ABCD-EFGH', expiresAt: null, autoApprove: true });
        await assert.rejects(
            handlerFor(devicesLinkCodeSetAutoApprove)(ctx, { code: 'NOPE-NOPE', autoApprove: true }),
            failsWith('not_found')
        );
    });

    it('la révocation retire le code de son émetteur, et ne se refait pas', async () => {
        const repo = fakeRepo([]);
        repo.codes.push({
            code: 'ABCD-EFGH',
            user_id: 1,
            workspace_id: 1,
            expires_at: null,
            used_at: null,
            auto_approve: false
        });
        const ctx = contextFor(repo, { isAdmin: true });
        const out = await handlerFor(devicesLinkCodeRevoke)(ctx, { code: 'abcd-efgh' });
        assert.deepEqual(out, { code: 'ABCD-EFGH' });
        assert.deepEqual(repo.codes, []);
        await assert.rejects(handlerFor(devicesLinkCodeRevoke)(ctx, { code: 'ABCD-EFGH' }), failsWith('not_found'));
    });
});

describe("l'historique", () => {
    it('les métriques relisent la fenêtre demandée, à la résolution demandée', async () => {
        const repo = fakeRepo([row({ id: DEVICE_A })]);
        repo.points.push({ ts: 1000, pinned: false }, { ts: 2000, pinned: false }, { ts: 3000, pinned: false });
        const out = await handlerFor(devicesMetrics)(contextFor(repo), {
            deviceId: DEVICE_A,
            from: 1500,
            to: 3500,
            resolution: 'minute'
        });
        devicesMetrics.output.parse(out);
        assert.deepEqual(
            out.points.map((p) => p.timestamp),
            [2000, 3000]
        );
        assert.deepEqual(repo.calls, [`metrics.query:${DEVICE_A}:minute`]);
    });

    it("la présence rend l'état au début de la fenêtre et les transitions dedans", async () => {
        const repo = fakeRepo([row({ id: DEVICE_A })]);
        repo.presenceEvents.push({ ts: 1000, online: true }, { ts: 2000, online: false }, { ts: 3000, online: true });
        const out = await handlerFor(devicesPresence)(contextFor(repo), { deviceId: DEVICE_A, from: 1500, to: 3500 });
        assert.equal(out.onlineAtStart, true);
        assert.deepEqual(
            out.events.map((e) => e.ts),
            [2000, 3000]
        );
    });

    it("les processus d'un instant sont ceux du relevé le plus proche, dans la tolérance", async () => {
        const repo = fakeRepo([row({ id: DEVICE_A })]);
        repo.samples.push(
            { ts: 1000, pinned: false, processes: 3, bytes: 10 },
            { ts: 5000, pinned: false, processes: 2, bytes: 8 }
        );
        const near = await handlerFor(devicesProcessesAt)(contextFor(repo), { deviceId: DEVICE_A, at: 1200 });
        assert.equal(near.sample?.ts, 1000);
        const far = await handlerFor(devicesProcessesAt)(contextFor(repo), { deviceId: DEVICE_A, at: 10 * 60_000 });
        assert.equal(far.sample, null);
    });

    it('les jours disponibles se découpent dans le fuseau du client', async () => {
        const repo = fakeRepo([row({ id: DEVICE_A })]);
        repo.points.push({ ts: 1000, pinned: false }, { ts: DAY_MS + 3_600_000, pinned: false });
        const utc = await handlerFor(devicesAvailability)(contextFor(repo), { deviceId: DEVICE_A, tzOffsetMinutes: 0 });
        assert.deepEqual(utc.days, ['1970-01-01', '1970-01-02']);
        // Deux heures à l'ouest : le second point retombe la veille.
        const west = await handlerFor(devicesAvailability)(contextFor(repo), {
            deviceId: DEVICE_A,
            tzOffsetMinutes: 120
        });
        assert.deepEqual(west.days, ['1969-12-31', '1970-01-01']);
    });

    it('les instants sont ceux des métriques ; les processus ne font que dire lesquels portent une liste', async () => {
        const repo = fakeRepo([row({ id: DEVICE_A })]);
        repo.points.push({ ts: 1000, pinned: true }, { ts: 2000, pinned: false }, { ts: 3000, pinned: false });
        repo.samples.push(
            { ts: 1000, pinned: true, processes: 1, bytes: 1 },
            { ts: 3000, pinned: false, processes: 1, bytes: 1 }
        );
        const out = await handlerFor(devicesSnapshots)(contextFor(repo), { deviceId: DEVICE_A, from: 0, to: 5000 });
        devicesSnapshots.output.parse(out);
        assert.deepEqual(out.timestamps, [1000, 2000, 3000]);
        assert.deepEqual(out.pinned, [1000]);
        assert.deepEqual(out.withProcesses, [1000, 3000]);
        assert.equal(out.truncated, false);
    });

    it("l'empreinte de stockage additionne les relevés, leurs processus et leurs octets", async () => {
        const repo = fakeRepo([row({ id: DEVICE_A })]);
        repo.samples.push(
            { ts: 1000, pinned: false, processes: 3, bytes: 10 },
            { ts: 2000, pinned: false, processes: 2, bytes: 8 }
        );
        const out = await handlerFor(devicesStorage)(contextFor(repo), { deviceId: DEVICE_A });
        assert.deepEqual(out, { deviceId: DEVICE_A, snapshots: 2, processes: 5, bytes: 18 });
    });

    it('la suppression de relevés compte ce qui part et le journalise, au singulier comme au pluriel', async () => {
        const repo = fakeRepo([row({ id: DEVICE_A, name: 'Serveur' })]);
        repo.samples.push(
            { ts: 1000, pinned: false, processes: 1, bytes: 1 },
            { ts: 2000, pinned: false, processes: 1, bytes: 1 },
            { ts: 3000, pinned: false, processes: 1, bytes: 1 }
        );
        const ctx = contextFor(repo);
        const range = await handlerFor(devicesDeleteSnapshots)(ctx, { deviceId: DEVICE_A, from: 1000, to: 2000 });
        assert.equal(range.deletedSnapshots, 2);
        const single = await handlerFor(devicesDeleteSnapshots)(ctx, { deviceId: DEVICE_A, from: 3000, to: 3000 });
        assert.equal(single.deletedSnapshots, 1);
        const none = await handlerFor(devicesDeleteSnapshots)(ctx, { deviceId: DEVICE_A, from: 0, to: 9000 });
        assert.equal(none.deletedSnapshots, 0);
        assert.deepEqual(
            ctx.recorded.audits.map((a) => a.description),
            ['2 snapshots supprimés : « Serveur »', 'Snapshot supprimé : « Serveur »']
        );
    });

    it("l'épinglage compte les instants métriques ; le désépinglage efface tout de suite ce qui est déjà expiré", async () => {
        const repo = fakeRepo([row({ id: DEVICE_A })]);
        const old = Date.now() - 40 * DAY_MS;
        const recent = Date.now() - 1000;
        repo.points.push({ ts: old, pinned: false }, { ts: recent, pinned: false });
        repo.samples.push({ ts: old, pinned: false, processes: 1, bytes: 1 });
        const ctx = contextFor(repo);

        const pinned = await handlerFor(devicesSetSnapshotsPinned)(ctx, {
            deviceId: DEVICE_A,
            from: 0,
            to: recent,
            pinned: true
        });
        assert.deepEqual(pinned, { deviceId: DEVICE_A, affected: 2, deletedSnapshots: 0 });
        assert.ok(repo.points.every((p) => p.pinned) && repo.samples[0].pinned);

        const unpinned = await handlerFor(devicesSetSnapshotsPinned)(ctx, {
            deviceId: DEVICE_A,
            from: 0,
            to: recent,
            pinned: false
        });
        // Sous la conservation par défaut (30 jours) : le vieil instant part,
        // le récent attend le balayage.
        assert.deepEqual(unpinned, { deviceId: DEVICE_A, affected: 2, deletedSnapshots: 1 });
        assert.deepEqual(
            repo.points.map((p) => p.ts),
            [recent]
        );
        assert.deepEqual(repo.samples, []);
        assert.ok(repo.calls.includes('metrics.expire:30') && repo.calls.includes('samples.expire:30'));
        assert.deepEqual(
            ctx.recorded.audits.map((a) => a.description),
            ['2 snapshot(s) épinglé(s) : « Machine 1 »', '2 snapshot(s) désépinglé(s) : « Machine 1 »']
        );
    });
});

describe('le contrat', () => {
    it('chaque commande a son handler, dans le même ordre', () => {
        assert.deepEqual(
            devicesHandlers.map((h) => h.command),
            devicesCommands.map((c) => c.command)
        );
    });

    it("la table des accès : l'administrateur pour la flotte et les codes, `write` pour ce qui range, règle ou efface, lecture ailleurs ; toute écriture bat `devices`", () => {
        const admin = new Set([
            'devices.confirm',
            'devices.revoke',
            'devices.reactivate',
            'devices.rename',
            'devices.workspaceList',
            'devices.setWorkspaces',
            'devices.requestDelete',
            'devices.cancelDelete',
            'devices.forceDelete',
            'devices.delete',
            'devices.linkCodeCreate',
            'devices.linkCodeList',
            'devices.linkCodeSetAutoApprove',
            'devices.linkCodeRevoke'
        ]);
        const write = new Set([
            'devices.reorder',
            'devices.setConfig',
            'devices.setSnapshotsPinned',
            'devices.deleteSnapshots'
        ]);
        const reads = new Set([
            'devices.list',
            'devices.workspaceList',
            'devices.linkCodeList',
            'devices.metrics',
            'devices.presence',
            'devices.processesAt',
            'devices.availability',
            'devices.snapshots',
            'devices.storage'
        ]);
        for (const h of devicesHandlers) {
            assert.equal(h.access?.admin === true, admin.has(h.command), `${h.command} : administrateur`);
            assert.equal(h.access?.level ?? 'read', write.has(h.command) ? 'write' : 'read', `${h.command} : niveau`);
            if (reads.has(h.command)) assert.equal(h.mutates, undefined, `${h.command} lit, et ne doit rien battre`);
            else assert.equal(h.mutates, true, `${h.command} écrit sans déclarer mutates`);
        }
    });
});
