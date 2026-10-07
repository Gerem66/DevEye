import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AuthWindow, MetricSnapshot, ReportProcess } from '@deveye/types';
import { createTestServiceDeps, testDevice } from '@deveye/types/sdk/testing';

import { SEVERITY_RANK, type FindingState } from '../contracts/domain';

import { dueSince, SentinelEngine, vanishedVerdict } from './engine';
import {
    emptyAttrs,
    findingDedup,
    type BaselineRow,
    type DeviceConfigRow,
    type FindingRow,
    type SentinelRepo
} from './repo';

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
    /** `deviceId|kind|clé` → ligne. */
    baselineRows: Map<string, BaselineRow>;
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
        baselineRows: baseline,
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
            forget: async (deviceId, kind, keys) => {
                for (const k of keys) baseline.delete(`${deviceId}|${kind}|${k}`);
                return keys.length;
            },
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
            resolveMissing: async (deviceId, rules, keep, at) => {
                let n = 0;
                for (const row of rows) {
                    if (row.device_id !== deviceId || row.state !== 'open' || !rules.includes(row.rule)) continue;
                    if (keep.some((b) => b.equals(findingDedup(row.rule, row.subject)))) continue;
                    row.state = 'resolved';
                    row.last_seen = at;
                    n++;
                }
                return n;
            },
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
            touchIntegrity: async (deviceId, at, format) => {
                const c = configs.find((x) => x.device_id === deviceId)!;
                c.last_integrity_at = at;
                c.persistence_format = format;
            },
            setSnapshotTicks: async (deviceId, ticks) => {
                configs.find((x) => x.device_id === deviceId)!.snapshot_ticks = ticks;
            },
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
        pin_evidence: 1,
        last_integrity_at: null,
        snapshot_ticks: 0,
        persistence_format: 1,
        ...over
    };
}

function proc(over: Partial<ReportProcess> & { name: string }): ReportProcess {
    return {
        execPath: null,
        deleted: null,
        kernel: null,
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
        // ne repart et personne n'est re-prévenu. Le programme, appris au tour
        // précédent, n'est plus nouveau : ce constat-là se ferme, et la vue le sait.
        await engine.onMetricsBatch('dev-1', [metric(TS)]);
        await deps.recorded.tickers[0].tick();
        assert.equal(repo.findings.rows.length, 2);
        assert.equal(critical.occurrences, 2);
        assert.equal(repo.findings.rows.find((r) => r.rule === 'process.new')!.state, 'resolved');
        assert.equal(deps.recorded.notifications.length, 1);
        assert.deepEqual(deps.recorded.liveChanges, [1, 1]);
    });

    it('ne laisse pas les fils du noyau entrer dans la ligne de base', async () => {
        const repo = fakeRepo([config({ device_id: 'dev-1' })]);
        const deps = createTestServiceDeps({
            repo,
            devices: [testDevice({ id: 'dev-1', workspaceId: 1 })],
            snapshots: [
                {
                    ts: TS,
                    // Le noyau recycle ces noms en continu : les retenir revient à
                    // fabriquer autant d'éléments qui apparaissent puis disparaissent.
                    processes: [
                        proc({ name: 'kworker/6:0H-kblockd', kernel: true }),
                        proc({ name: 'jbd2/nvme1n1p1-8' }),
                        proc({ name: 'nginx', execPath: '/usr/sbin/nginx', kernel: false })
                    ],
                    activeConnections: 3
                }
            ]
        });
        const engine = new SentinelEngine(deps);

        await engine.onMetricsBatch('dev-1', [metric(TS)]);
        await deps.recorded.tickers[0].tick();

        assert.deepEqual([...(await repo.baseline.known('dev-1', 'process')).keys()], ['nginx|/usr/sbin/nginx']);
        assert.deepEqual(
            repo.findings.rows.map((r) => r.subject),
            ['nginx|/usr/sbin/nginx']
        );
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
            unavailable: false,
            truncated: false
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

describe('vanishedVerdict : l’absence se compte en instants de la machine', () => {
    const limits = { absentTicks: 60, streakTicks: 4320, forgetTicks: 43_200 };

    it('un service longtemps présent, absent depuis une heure de relevés : disparu', () => {
        assert.equal(vanishedVerdict({ lastTick: 5000, streak: 5000 }, 5060, limits), 'vanished');
    });
    it('absent depuis moins d’une heure : encore là', () => {
        assert.equal(vanishedVerdict({ lastTick: 5000, streak: 5000 }, 5059, limits), 'present');
    });
    it('un programme qu’on ouvre et ferme n’a pas de série assez longue', () => {
        assert.equal(vanishedVerdict({ lastTick: 5000, streak: 600 }, 6000, limits), 'present');
    });
    it('un mois d’activité sans lui : oublié', () => {
        assert.equal(vanishedVerdict({ lastTick: 5000, streak: 5000 }, 48_200, limits), 'forget');
    });
});

describe('la passe lente : Programme disparu', () => {
    const NGINX = 'nginx|/usr/sbin/nginx';

    /** Une ligne de base où nginx a été vu sans interruption pendant `streak` instants, jusqu'à `lastTick`. */
    function seed(repo: FakeRepo, lastTick: number, streak: number): void {
        repo.baselineRows.set(`dev-1|process|${NGINX}`, {
            id: 1,
            device_id: 'dev-1',
            kind: 'process',
            item_key: NGINX,
            first_seen: TS - 30 * 86_400_000,
            last_seen: TS - 86_400_000,
            samples: streak,
            attrs: { ...emptyAttrs(), users: ['www-data'], lastTick, streak }
        });
    }

    async function slowPass(repo: FakeRepo, snapshots: (typeof SUSPECT)[] = []) {
        const deps = createTestServiceDeps({
            repo,
            devices: [testDevice({ id: 'dev-1', name: 'Serveur', workspaceId: 1 })],
            snapshots
        });
        // Un moteur neuf passe la passe lente à son premier tour.
        const engine = new SentinelEngine(deps);
        return { deps, engine };
    }

    it('une machine éteinte ne fait rien disparaître, quel que soit le temps passé', async () => {
        // Horloge figée : aucun instant n'est arrivé depuis le dernier passage de nginx.
        const repo = fakeRepo([config({ device_id: 'dev-1', snapshot_ticks: 5000 })]);
        seed(repo, 5000, 5000);
        const { deps } = await slowPass(repo);
        await deps.recorded.tickers[0].tick();
        assert.equal(repo.findings.rows.length, 0);
    });

    it('un service arrêté pendant que la machine tourne est signalé, puis fermé à son retour', async () => {
        const repo = fakeRepo([config({ device_id: 'dev-1', snapshot_ticks: 5060 })]);
        seed(repo, 5000, 5000);
        const first = await slowPass(repo);
        await first.deps.recorded.tickers[0].tick();
        assert.deepEqual(
            repo.findings.rows.map((r) => [r.rule, r.state]),
            [['process.vanished', 'open']]
        );
        // La ligne reste : le retour du programme le trouvera connu.
        assert.ok(repo.baselineRows.has(`dev-1|process|${NGINX}`));

        // nginx revient : connu, il n'ouvre pas « Nouveau programme », et la passe
        // lente qui suit rejoue la famille, ce qui ferme le constat.
        const back = await slowPass(repo, [
            {
                ts: TS,
                processes: [proc({ name: 'nginx', execPath: '/usr/sbin/nginx', user: 'www-data' })],
                activeConnections: 3
            }
        ]);
        await back.engine.onMetricsBatch('dev-1', [metric(TS)]);
        await back.deps.recorded.tickers[0].tick();
        assert.deepEqual(
            repo.findings.rows.map((r) => [r.rule, r.state]),
            [['process.vanished', 'resolved']]
        );
        assert.deepEqual(back.deps.recorded.liveChanges, [1]);
    });

    it('un mois d’activité sans lui : oublié, et son constat fermé', async () => {
        const repo = fakeRepo([config({ device_id: 'dev-1', snapshot_ticks: 5060 })]);
        seed(repo, 5000, 5000);
        const first = await slowPass(repo);
        await first.deps.recorded.tickers[0].tick();
        repo.configs.get('dev-1')!.snapshot_ticks = 5000 + 43_200;
        const later = await slowPass(repo);
        await later.deps.recorded.tickers[0].tick();
        assert.equal(repo.baselineRows.has(`dev-1|process|${NGINX}`), false);
        assert.equal(repo.findings.rows[0].state, 'resolved');
    });

    it('un programme qu’on ouvre et ferme ne disparaît pas', async () => {
        const repo = fakeRepo([config({ device_id: 'dev-1', snapshot_ticks: 9000 })]);
        seed(repo, 5000, 600);
        const { deps } = await slowPass(repo);
        await deps.recorded.tickers[0].tick();
        assert.equal(repo.findings.rows.length, 0);
    });

    it('chaque instant fait avancer l’horloge et prolonge la série', async () => {
        const repo = fakeRepo([config({ device_id: 'dev-1', snapshot_ticks: 41 })]);
        seed(repo, 41, 41);
        const { deps, engine } = await slowPass(repo, [
            {
                ts: TS,
                processes: [proc({ name: 'nginx', execPath: '/usr/sbin/nginx', user: 'www-data' })],
                activeConnections: 3
            }
        ]);
        await engine.onMetricsBatch('dev-1', [metric(TS)]);
        await deps.recorded.tickers[0].tick();
        assert.equal(repo.configs.get('dev-1')!.snapshot_ticks, 42);
        const attrs = repo.baselineRows.get(`dev-1|process|${NGINX}`)!.attrs as { lastTick: number; streak: number };
        assert.deepEqual([attrs.lastTick, attrs.streak], [42, 42]);
    });
});

describe('le manifeste de persistance : un format à la fois', () => {
    const CRON = '/etc/cron.d/backup';
    const manifest = (format: number, sha256: string) => ({
        collectedAt: TS,
        format,
        truncated: false,
        entries: [
            {
                surface: 'cron',
                path: CRON,
                sha256,
                sizeBytes: 10,
                mtime: null,
                mode: '0644',
                owner: 'root',
                vendor: null
            }
        ]
    });

    it('un nouveau format s’apprend sans constat, le suivant se compare', async () => {
        const repo = fakeRepo([config({ device_id: 'dev-1', persistence_format: 1 })]);
        repo.baselineRows.set(`dev-1|persistence|${CRON}`, {
            id: 1,
            device_id: 'dev-1',
            kind: 'persistence',
            item_key: CRON,
            first_seen: TS,
            last_seen: TS,
            samples: 1,
            attrs: { ...emptyAttrs(), sha256: 'a'.repeat(64), surface: 'cron' }
        });
        const deps = createTestServiceDeps({ repo, devices: [testDevice({ id: 'dev-1', workspaceId: 1 })] });
        const engine = new SentinelEngine(deps);

        // L'agent change sa façon d'empreinter : l'empreinte diffère, rien ne sonne.
        await engine.onIntegrity('dev-1', manifest(2, 'b'.repeat(64)));
        await deps.recorded.tickers[0].tick();
        assert.equal(repo.findings.rows.length, 0);
        assert.equal(repo.configs.get('dev-1')!.persistence_format, 2);

        // Même format, empreinte changée : là, c'est une modification.
        engine.invalidate('dev-1');
        await engine.onIntegrity('dev-1', manifest(2, 'c'.repeat(64)));
        await deps.recorded.tickers[0].tick();
        assert.deepEqual(
            repo.findings.rows.map((r) => r.rule),
            ['persistence.modified']
        );
    });
});
