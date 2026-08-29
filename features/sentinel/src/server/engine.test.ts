import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AuthWindow, MetricSnapshot, ReportProcess } from '@deveye/types';
import { createTestServiceDeps, testDevice } from '@deveye/types/sdk/testing';

import { SEVERITY_RANK, type FindingState } from '../contracts/domain';

import { dueSince, SentinelEngine } from './engine';
import type { BaselineRow, DeviceConfigRow, FindingRow, SentinelRepo } from './repo';

/**
 * Ce qui ne lève nulle part quand ça se dérègle : le plancher d'évaluation (une
 * reconnexion en boucle ne rejoue pas les relevés), un tour complet sur un
 * instant suspect (constat ouvert, preuve épinglée, vue prévenue, alerte une
 * seule fois), et la garde à l'ingestion (appareil non surveillé ou sonde
 * éteinte : rien n'est évalué).
 */

interface FakeRepo extends SentinelRepo {
    findings: SentinelRepo['findings'] & { rows: FindingRow[] };
    configs: Map<string, DeviceConfigRow>;
}

const unused = async () => {
    throw new Error('non attendu ici');
};

/** Un dépôt en mémoire : ligne de base, constats et config par appareil, sans autorisations. */
function fakeRepo(configs: DeviceConfigRow[]): FakeRepo {
    const baseline = new Map<string, BaselineRow>();
    const rows: FindingRow[] = [];
    let seq = 0;
    const key = (deviceId: string, rule: string, subject: string) => `${deviceId}|${rule}|${subject}`;
    return {
        configs: new Map(configs.map((c) => [c.device_id, c])),
        baseline: {
            observe: async (deviceId, at, items) => {
                for (const item of items) {
                    const k = `${deviceId}|${item.kind}|${item.key}`;
                    const known = baseline.get(k);
                    baseline.set(k, {
                        id: known?.id ?? ++seq,
                        device_id: deviceId,
                        kind: item.kind,
                        item_key: item.key,
                        first_seen: known?.first_seen ?? at,
                        last_seen: at,
                        samples: (known?.samples ?? 0) + 1,
                        attrs: item.attrs
                    });
                }
            },
            known: async (deviceId, kind) =>
                new Map(
                    [...baseline.values()]
                        .filter((r) => r.device_id === deviceId && r.kind === kind)
                        .map((r) => [r.item_key, r])
                ),
            list: unused,
            staleSince: async () => [],
            forget: async () => 0,
            reset: async () => 0
        },
        findings: {
            rows,
            upsert: async (deviceId, draft, at) => {
                const existing = rows.find(
                    (r) => key(r.device_id, r.rule, r.subject) === key(deviceId, draft.rule, draft.subject)
                );
                if (!existing) {
                    rows.push({
                        id: ++seq,
                        device_id: deviceId,
                        rule: draft.rule,
                        severity: SEVERITY_RANK[draft.severity],
                        state: 'open',
                        subject: draft.subject,
                        evidence: draft.evidence,
                        snapshot_ts: draft.snapshotTs,
                        first_seen: at,
                        last_seen: at,
                        occurrences: 1,
                        notified: 0,
                        acked_by: null,
                        acked_at: null
                    });
                    return { id: seq, isNew: true, severity: draft.severity };
                }
                const reopened: boolean = existing.state === 'resolved';
                if (existing.state !== 'acknowledged') existing.state = 'open' as FindingState;
                existing.last_seen = at;
                existing.occurrences += 1;
                return { id: existing.id, isNew: reopened, severity: draft.severity };
            },
            resolveMissing: async () => 0,
            find: unused,
            list: unused,
            openCounts: unused,
            openCountsByDevice: unused,
            acknowledge: unused,
            resolve: unused,
            reopen: unused,
            markNotified: async (ids) => {
                for (const row of rows) if (ids.includes(row.id)) row.notified = 1;
            },
            pruneResolved: async () => 0
        },
        allow: {
            forDevice: async () => new Set<string>(),
            list: unused,
            add: unused,
            find: unused,
            remove: unused,
            removeFor: unused
        },
        deviceConfig: {
            get: async (deviceId) => configs.find((c) => c.device_id === deviceId) ?? null,
            forDevices: unused,
            set: unused,
            touchIntegrity: async () => undefined,
            listEnabled: async () => configs.filter((c) => c.enabled === 1).map((c) => c.device_id)
        }
    };
}

function config(over: Partial<DeviceConfigRow> & { device_id: string }): DeviceConfigRow {
    return {
        enabled: 1,
        learning_until: null,
        integrity_minutes: 360,
        auth_events: 1,
        last_integrity_at: null,
        ...over
    };
}

function proc(over: Partial<ReportProcess> & { name: string }): ReportProcess {
    return {
        execPath: null,
        deleted: null,
        instances: 1,
        cpuPercent: 0.1,
        memBytes: 1024 * 1024,
        threads: null,
        user: 'root',
        uptimeSeconds: 100,
        diskReadBytes: null,
        diskWriteBytes: null,
        connIn: null,
        connOut: null,
        listenPorts: [],
        ...over
    };
}

const TS = 1_700_000_000_000;
/** Un instant où un binaire tourne depuis /tmp : critique, donc notifié et épinglé. */
const SUSPECT = {
    ts: TS,
    processes: [proc({ name: 'kdevtmpfsi', execPath: '/tmp/kdevtmpfsi' })],
    activeConnections: 3
};
const metric = (ts: number): MetricSnapshot => ({ timestamp: ts, processes: null }) as unknown as MetricSnapshot;

describe('dueSince : le plancher d’évaluation', () => {
    const FLOOR = 10 * 60 * 1000;
    const NOW = 1_700_000_000_000;

    it('autorise quand rien n’a jamais été évalué', () => {
        // Premier relevé d'un appareil : sans ça la détection n'existerait pas
        // avant dix minutes de vie.
        assert.equal(dueSince(undefined, NOW, FLOOR), true);
    });

    it('refuse deux évaluations rapprochées', () => {
        assert.equal(dueSince(NOW, NOW, FLOOR), false);
        assert.equal(dueSince(NOW - (FLOOR - 1), NOW, FLOOR), false);
    });

    it('autorise de nouveau à l’échéance exacte et au-delà', () => {
        assert.equal(dueSince(NOW - FLOOR, NOW, FLOOR), true);
        assert.equal(dueSince(NOW - 3_600_000, NOW, FLOOR), true);
    });
});

describe('un tour du moteur', () => {
    it('pose un ticker à la cadence du module', () => {
        const deps = createTestServiceDeps({ repo: fakeRepo([]) });
        new SentinelEngine(deps);
        assert.deepEqual(
            deps.recorded.tickers.map((t) => t.intervalMs),
            [60_000]
        );
    });

    it('ouvre le constat, épingle la preuve, prévient la vue et notifie une seule fois', async () => {
        const repo = fakeRepo([config({ device_id: 'dev-1' })]);
        const deps = createTestServiceDeps({
            repo,
            devices: [testDevice({ id: 'dev-1', name: 'Serveur', workspaceId: 1, ownerUserId: 7 })],
            snapshots: [SUSPECT]
        });
        const engine = new SentinelEngine(deps);

        // L'instant arrive par le hook, comme la couche socket le tend ; il
        // n'est pas évalué avant le tour.
        await engine.onMetricsBatch('dev-1', [metric(TS - 60_000), metric(TS)]);
        assert.equal(repo.findings.rows.length, 0);

        await deps.recorded.tickers[0].tick();
        // Deux constats : le chemin suspect (critique) et le programme inconnu
        // (à surveiller, hors apprentissage).
        assert.deepEqual(repo.findings.rows.map((r) => r.rule).sort(), ['exec.suspicious_path', 'process.new']);
        // Chaque constat ouvert s'audite au nom du propriétaire de l'appareil.
        assert.equal(deps.recorded.audits.length, 2);
        assert.ok(deps.recorded.audits.some((a) => a.action === 'exec.suspicious_path'));
        // La preuve du constat sérieux est épinglée ; l'espace est prévenu une fois.
        assert.deepEqual(deps.recorded.pinnedInstants, [{ deviceId: 'dev-1', ts: TS }]);
        assert.deepEqual(deps.recorded.liveChanges, [1]);
        // Une seule alerte, groupée, avec sa mise en page Discord, à partir de `high`.
        assert.equal(deps.recorded.notifications.length, 1);
        assert.ok(deps.recorded.notifications[0].subject.includes('critical'));
        assert.ok(deps.recorded.notifications[0].subject.includes('Serveur'));
        assert.ok(deps.recorded.notifications[0].body.includes('kdevtmpfsi'));
        assert.equal(deps.recorded.notifications[0].embeds, 1);
        const critical = repo.findings.rows.find((r) => r.rule === 'exec.suspicious_path')!;
        assert.equal(critical.notified, 1);

        // Le même instant, encore : la situation dure, le compteur monte, rien
        // ne repart et personne n'est re-prévenu.
        await engine.onMetricsBatch('dev-1', [metric(TS)]);
        await deps.recorded.tickers[0].tick();
        assert.equal(repo.findings.rows.length, 2);
        assert.equal(critical.occurrences, 2);
        assert.equal(deps.recorded.notifications.length, 1);
        assert.deepEqual(deps.recorded.liveChanges, [1]);
    });

    it('n’évalue rien pour un appareil non surveillé, ni pour une sonde éteinte', async () => {
        const repo = fakeRepo([
            config({ device_id: 'dev-off', enabled: 0 }),
            config({ device_id: 'dev-quiet', auth_events: 0 })
        ]);
        const deps = createTestServiceDeps({
            repo,
            devices: [
                testDevice({ id: 'dev-off', workspaceId: 1 }),
                testDevice({ id: 'dev-none', workspaceId: 1 }),
                testDevice({ id: 'dev-quiet', workspaceId: 1 })
            ],
            snapshots: [SUSPECT]
        });
        const engine = new SentinelEngine(deps);

        // Éteint, ou sans ligne de config du tout : la télémétrie est ignorée.
        await engine.onMetricsBatch('dev-off', [metric(TS)]);
        await engine.onMetricsBatch('dev-none', [metric(TS)]);
        await engine.onReport('dev-none');
        // Surveillé, mais la sonde d'authentification est éteinte : la fenêtre
        // est jetée, même si l'agent l'a envoyée.
        const auth: AuthWindow = {
            from: TS,
            to: TS + 3_600_000,
            failed: 42,
            accepted: 0,
            invalidUser: 0,
            sudo: 0,
            newAccounts: ['backdoor'],
            rootLogins: 0,
            topSources: [{ address: '1.2.3.4', failed: 42, accepted: 0, users: ['root'] }],
            logins: [],
            unavailable: false
        };
        await engine.onAuthEvents('dev-quiet', auth);

        await deps.recorded.tickers[0].tick();
        assert.equal(repo.findings.rows.length, 0);
        assert.equal(deps.recorded.notifications.length, 0);
        assert.deepEqual(deps.recorded.liveChanges, []);

        // La même fenêtre, sonde allumée : les deux constats d'authentification s'ouvrent.
        repo.configs.get('dev-quiet')!.auth_events = 1;
        await engine.onAuthEvents('dev-quiet', auth);
        await deps.recorded.tickers[0].tick();
        assert.deepEqual(repo.findings.rows.map((r) => r.rule).sort(), ['auth.bruteforce', 'auth.new_account']);
    });
});
