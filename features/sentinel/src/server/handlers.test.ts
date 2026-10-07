import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { z, ZodType } from 'zod';

import { FeatureError, type SdkFeatureContext } from '@deveye/types/sdk/server';
import { createTestContext, createTestServiceDeps, testDevice } from '@deveye/types/sdk/testing';

import {
    sentinelAcknowledge,
    sentinelAllowlist,
    sentinelCount,
    sentinelFindings,
    sentinelOverview,
    sentinelResetBaseline,
    sentinelResolve,
    sentinelScanNow,
    sentinelSetConfig
} from '../contracts/commands';
import { SEVERITY_RANK, type FindingSeverity, type FindingState } from '../contracts/domain';

import { SentinelEngine } from './engine';
import { sentinelHandlers } from './handlers';
import type { AllowRow, DeviceConfigRow, FindingRow, SentinelRepo } from './repo';
import { setEngine } from './_shared';

/**
 * Ce qui ne lève nulle part quand ça se dérègle : le périmètre et les noms
 * d'appareils viennent de la façade, la config par appareil de la table du
 * module, acquitter écrit l'autorisation avant de clore, et un relevé immédiat
 * se refuse à une machine non surveillée.
 */

/** Le handler d'un contrat, typé par ce contrat (le registre est hétérogène). */
function handlerFor<C extends { command: string; input: ZodType; output: ZodType }>(contract: C) {
    const def = sentinelHandlers.find((h) => h.command === contract.command);
    assert.ok(def, `handler ${contract.command} manquant`);
    return def.handler as (
        ctx: SdkFeatureContext<SentinelRepo>,
        input: z.output<C['input']>
    ) => Promise<z.input<C['output']>>;
}

interface FakeRepo extends SentinelRepo {
    findingRows: FindingRow[];
    allowRows: AllowRow[];
    configs: Map<string, DeviceConfigRow>;
    resets: string[];
}

function finding(over: Partial<FindingRow> & { id: number; device_id: string }): FindingRow {
    return {
        rule: 'exec.suspicious_path',
        severity: SEVERITY_RANK.critical,
        state: 'open',
        subject: 'kdevtmpfsi|/tmp/kdevtmpfsi',
        evidence: [],
        snapshot_ts: null,
        first_seen: 1,
        last_seen: 2,
        occurrences: 1,
        notified: 0,
        acked_by: null,
        acked_at: null,
        ...over
    };
}

/** Un dépôt en mémoire, même contrat que le vrai. Les tableaux sont mutés en place. */
function fakeRepo(findings: FindingRow[] = [], configs: DeviceConfigRow[] = []): FakeRepo {
    const findingRows = [...findings];
    const allowRows: AllowRow[] = [];
    const configMap = new Map(configs.map((c) => [c.device_id, c]));
    const resets: string[] = [];
    let seq = 100;
    const unused = async () => {
        throw new Error('non attendu ici');
    };
    return {
        findingRows,
        allowRows,
        configs: configMap,
        resets,
        baseline: {
            observe: unused,
            known: unused,
            list: async () => ({ rows: [], total: 0 }),
            forget: unused,
            reset: async (deviceId) => {
                resets.push(deviceId);
                return 3;
            }
        },
        findings: {
            upsert: unused,
            resolveMissing: unused,
            find: async (id) => findingRows.find((r) => r.id === id) ?? null,
            list: async (filter) => {
                const rows = findingRows.filter(
                    (r) =>
                        filter.workspaceDeviceIds.includes(r.device_id) &&
                        (filter.deviceId === null || r.device_id === filter.deviceId) &&
                        (filter.state === null || r.state === filter.state)
                );
                return { rows, total: rows.length };
            },
            openCounts: async (deviceIds) => {
                const out: Record<FindingSeverity, number> = { info: 0, low: 0, high: 0, critical: 0 };
                for (const r of findingRows) {
                    if (r.state !== 'open' || !deviceIds.includes(r.device_id)) continue;
                    if (r.severity === SEVERITY_RANK.critical) out.critical++;
                    else if (r.severity === SEVERITY_RANK.high) out.high++;
                    else if (r.severity === SEVERITY_RANK.low) out.low++;
                    else out.info++;
                }
                return out;
            },
            openCountsByDevice: async (deviceIds) => {
                const out = new Map<string, Record<FindingSeverity, number>>();
                for (const id of deviceIds) out.set(id, { info: 0, low: 0, high: 0, critical: 0 });
                for (const r of findingRows) {
                    const counts = r.state === 'open' ? out.get(r.device_id) : undefined;
                    if (!counts) continue;
                    if (r.severity === SEVERITY_RANK.critical) counts.critical++;
                    else if (r.severity === SEVERITY_RANK.high) counts.high++;
                    else if (r.severity === SEVERITY_RANK.low) counts.low++;
                    else counts.info++;
                }
                return out;
            },
            acknowledge: async (id, userId, at) => {
                const row = findingRows.find((r) => r.id === id)!;
                row.state = 'acknowledged' as FindingState;
                row.acked_by = userId;
                row.acked_at = at;
            },
            resolve: async (id, at) => {
                const row = findingRows.find((r) => r.id === id)!;
                if (row.state !== 'open') return;
                row.state = 'resolved' as FindingState;
                row.last_seen = at;
            },
            reopen: unused,
            markNotified: unused,
            pruneResolved: unused
        },
        allow: {
            forDevice: async () => new Set<string>(),
            list: async (workspaceId, deviceId) =>
                allowRows.filter(
                    (a) =>
                        a.workspace_id === workspaceId &&
                        (deviceId === null || a.device_id === deviceId || a.device_id === null)
                ),
            add: async (entry) => {
                const row: AllowRow = {
                    id: ++seq,
                    workspace_id: entry.workspaceId,
                    device_id: entry.deviceId,
                    rule: entry.rule,
                    subject: entry.subject,
                    reason: entry.reason,
                    created_by: entry.createdBy,
                    created: entry.at
                };
                allowRows.push(row);
                return row;
            },
            find: unused,
            remove: unused,
            removeFor: unused
        },
        deviceConfig: {
            get: async (deviceId) => configMap.get(deviceId) ?? null,
            forDevices: async (ids) => new Map([...configMap].filter(([id]) => ids.includes(id))),
            set: async (deviceId, patch) => {
                const current = configMap.get(deviceId) ?? {
                    device_id: deviceId,
                    enabled: 0,
                    learning_until: null,
                    integrity_minutes: 360,
                    auth_events: 1,
                    pin_evidence: 1,
                    last_integrity_at: null,
                    snapshot_ticks: 0,
                    persistence_format: null
                };
                configMap.set(deviceId, {
                    ...current,
                    enabled: patch.enabled === undefined ? current.enabled : patch.enabled ? 1 : 0,
                    learning_until: patch.learningUntil === undefined ? current.learning_until : patch.learningUntil,
                    integrity_minutes: patch.integrityMinutes ?? current.integrity_minutes,
                    auth_events: patch.authEvents === undefined ? current.auth_events : patch.authEvents ? 1 : 0,
                    pin_evidence: patch.pinEvidence === undefined ? current.pin_evidence : patch.pinEvidence ? 1 : 0
                });
            },
            touchIntegrity: unused,
            setSnapshotTicks: unused,
            listEnabled: async () => [...configMap.values()].filter((c) => c.enabled === 1).map((c) => c.device_id)
        }
    };
}

const WATCHED: DeviceConfigRow = {
    device_id: 'dev-a',
    enabled: 1,
    learning_until: null,
    integrity_minutes: 180,
    auth_events: 0,
    pin_evidence: 1,
    last_integrity_at: 1_700_000_000_000,
    snapshot_ticks: 0,
    persistence_format: 1
};

const FLEET = [
    testDevice({ id: 'dev-a', name: 'Serveur', workspaceId: 1 }),
    testDevice({ id: 'dev-b', name: 'Portable', workspaceId: 1 }),
    testDevice({ id: 'dev-c', name: 'Éteint', workspaceId: 1 })
];

describe('sentinel.overview et sentinel.count : le périmètre vient de la façade', () => {
    it('trie au pire d’abord, les machines non surveillées en dernier, et compte ce qui est surveillé', async () => {
        const repo = fakeRepo(
            [finding({ id: 1, device_id: 'dev-b' })],
            [WATCHED, { ...WATCHED, device_id: 'dev-b', integrity_minutes: 360, auth_events: 1 }]
        );
        const ctx = createTestContext({ repo, devices: FLEET });

        const overview = await handlerFor(sentinelOverview)(ctx, {});
        assert.deepEqual(
            overview.devices.map((d) => d.deviceId),
            ['dev-b', 'dev-a', 'dev-c']
        );
        assert.equal(overview.open.critical, 1);
        // Sans rapport, aucune posture n'est mesurable : `null`, jamais 0.
        assert.equal(overview.fleetScore, null);
        // L'état porte ce qui est réglé (et les défauts sans ligne), pour que le
        // panneau parte de la vraie valeur.
        const a = overview.devices.find((d) => d.deviceId === 'dev-a')!;
        assert.equal(a.integrityMinutes, 180);
        assert.equal(a.authEvents, false);
        assert.equal(a.lastIntegrityAt, 1_700_000_000_000);
        const c = overview.devices.find((d) => d.deviceId === 'dev-c')!;
        assert.equal(c.enabled, false);
        assert.equal(c.integrityMinutes, 360);

        const count = await handlerFor(sentinelCount)(ctx, {});
        assert.deepEqual(count, { open: { info: 0, low: 0, high: 0, critical: 1 }, watched: 2 });
    });

    it('nomme les constats par la façade, un appareil hors périmètre par son identifiant tronqué', async () => {
        const repo = fakeRepo([finding({ id: 1, device_id: 'dev-a' }), finding({ id: 2, device_id: 'dev-b' })]);
        // Seul dev-a est visible d'ici : le constat de dev-b ne sort pas.
        const ctx = createTestContext({ repo, devices: [FLEET[0]] });
        const listed = await handlerFor(sentinelFindings)(ctx, {
            deviceId: null,
            state: 'open',
            minSeverity: null,
            rule: null,
            limit: 50,
            offset: 0
        });
        assert.deepEqual(
            listed.findings.map((f) => [f.id, f.deviceName]),
            [[1, 'Serveur']]
        );
    });
});

describe('sentinel.acknowledge : l’autorisation d’abord', () => {
    it('écrit l’autorisation dans l’espace de l’appareil, puis clôt le constat', async () => {
        const repo = fakeRepo([finding({ id: 1, device_id: 'dev-a' })]);
        const ctx = createTestContext({ repo, devices: FLEET, userId: 9 });

        const out = await handlerFor(sentinelAcknowledge)(ctx, { findingIds: [1], scope: 'device', reason: 'à nous' });
        assert.equal(out.findings[0].state, 'acknowledged');
        assert.equal(out.findings[0].deviceName, 'Serveur');
        assert.equal(repo.allowRows[0].device_id, 'dev-a');
        assert.equal(repo.allowRows[0].workspace_id, 1);
        assert.equal(repo.allowRows[0].created_by, 9);
        assert.equal(ctx.recorded.audits[0].action, 'sentinel.acknowledge');

        // En portée flotte, l'autorisation n'a pas d'appareil, donc pas de nom.
        repo.findingRows.push(finding({ id: 2, device_id: 'dev-b', state: 'open' }));
        await handlerFor(sentinelAcknowledge)(ctx, { findingIds: [2], scope: 'fleet', reason: null });
        assert.equal(repo.allowRows[1].device_id, null);

        const listed = await handlerFor(sentinelAllowlist)(ctx, { deviceId: 'dev-a' });
        assert.deepEqual(
            listed.entries.map((e) => e.deviceName),
            ['Serveur', null]
        );
    });
});

describe('sentinel.acknowledge et sentinel.resolve : un groupe d’un geste', () => {
    it('acquitte tout le groupe, sans réécrire ce qui l’était déjà', async () => {
        const repo = fakeRepo([
            finding({ id: 1, device_id: 'dev-a', subject: 'udp/*:dynamique|firefox' }),
            finding({ id: 2, device_id: 'dev-a', subject: 'udp/*:dynamique|discord' }),
            finding({ id: 3, device_id: 'dev-a', subject: 'udp/*:dynamique|steam', state: 'acknowledged' })
        ]);
        const ctx = createTestContext({ repo, devices: FLEET, userId: 9 });

        const out = await handlerFor(sentinelAcknowledge)(ctx, {
            findingIds: [1, 2, 3],
            scope: 'device',
            reason: null
        });
        assert.deepEqual(
            out.findings.map((f) => f.state),
            ['acknowledged', 'acknowledged', 'acknowledged']
        );
        assert.deepEqual(
            repo.allowRows.map((a) => a.subject),
            ['udp/*:dynamique|firefox', 'udp/*:dynamique|discord']
        );
        assert.equal(ctx.recorded.audits.length, 2);
    });

    it('refuse le lot entier avant toute écriture si un constat manque', async () => {
        const repo = fakeRepo([finding({ id: 1, device_id: 'dev-a' })]);
        const ctx = createTestContext({ repo, devices: FLEET });
        await assert.rejects(
            handlerFor(sentinelAcknowledge)(ctx, { findingIds: [1, 99], scope: 'device', reason: null }),
            (e: unknown) => e instanceof FeatureError && e.code === 'not_found'
        );
        assert.equal(repo.allowRows.length, 0);
        assert.equal(repo.findingRows[0].state, 'open');
    });

    it('« c’est réglé » ferme les ouverts du lot, et refuse un lot sans aucun ouvert', async () => {
        const repo = fakeRepo([
            finding({ id: 1, device_id: 'dev-a' }),
            finding({ id: 2, device_id: 'dev-a', state: 'acknowledged' })
        ]);
        const ctx = createTestContext({ repo, devices: FLEET });

        const out = await handlerFor(sentinelResolve)(ctx, { findingIds: [1, 2] });
        assert.deepEqual(
            out.findings.map((f) => f.state),
            ['resolved', 'acknowledged']
        );
        assert.equal(repo.allowRows.length, 0);
        await assert.rejects(
            handlerFor(sentinelResolve)(ctx, { findingIds: [1, 2] }),
            (e: unknown) => e instanceof FeatureError && e.code === 'conflict'
        );
    });
});

describe('sentinel.scanNow et sentinel.setConfig : l’agent par la façade', () => {
    it('refuse un relevé sur une machine non surveillée, le demande sinon', async () => {
        const repo = fakeRepo([], [WATCHED]);
        const ctx = createTestContext({ repo, devices: FLEET });
        await assert.rejects(
            handlerFor(sentinelScanNow)(ctx, { deviceId: 'dev-c' }),
            (e: unknown) => e instanceof FeatureError && e.code === 'conflict'
        );
        const out = await handlerFor(sentinelScanNow)(ctx, { deviceId: 'dev-a' });
        assert.deepEqual(out, { deviceId: 'dev-a', requested: true });
        assert.deepEqual(ctx.recorded.agentRequests, [{ method: 'requestScan', deviceId: 'dev-a' }]);
    });

    it('active la surveillance : ligne de config, fenêtre d’apprentissage, config poussée à l’agent', async () => {
        const repo = fakeRepo();
        const ctx = createTestContext({ repo, devices: FLEET });
        const before = Date.now();
        const out = await handlerFor(sentinelSetConfig)(ctx, {
            deviceId: 'dev-c',
            enabled: true,
            learningDays: 3,
            integrityMinutes: 60,
            authEvents: false,
            pinEvidence: null
        });
        assert.equal(out.device.enabled, true);
        assert.equal(out.device.learning, true);
        assert.ok((out.device.learningUntil ?? 0) >= before + 3 * 86400000);
        assert.equal(out.device.integrityMinutes, 60);
        assert.equal(out.device.authEvents, false);
        assert.equal(repo.configs.get('dev-c')?.enabled, 1);
        // C'est l'app qui recompose la config de l'agent ; le module la fait pousser.
        assert.deepEqual(ctx.recorded.agentRequests, [{ method: 'pushConfig', deviceId: 'dev-c' }]);
        assert.equal(ctx.recorded.audits[0].action, 'sentinel.setConfig');

        // Réenregistrer une machine déjà surveillée ne relance pas l'apprentissage.
        const until = repo.configs.get('dev-c')!.learning_until;
        await handlerFor(sentinelSetConfig)(ctx, {
            deviceId: 'dev-c',
            enabled: true,
            learningDays: null,
            integrityMinutes: 120,
            authEvents: null,
            pinEvidence: false
        });
        assert.equal(repo.configs.get('dev-c')!.learning_until, until);
        assert.equal(repo.configs.get('dev-c')!.integrity_minutes, 120);
        // L'épinglage se refuse comme le reste : ce que le moteur garde dans
        // l'historique de Monitoring n'a pas à s'imposer.
        assert.equal(repo.configs.get('dev-c')!.pin_evidence, 0);
    });
});

describe('sentinel.resetBaseline : le moteur du module', () => {
    it('répond `internal` sans moteur, et sinon efface, oublie le cache et relance l’apprentissage', async () => {
        setEngine(null);
        const repo = fakeRepo([], [WATCHED]);
        const ctx = createTestContext({ repo, devices: FLEET });
        await assert.rejects(
            handlerFor(sentinelResetBaseline)(ctx, { deviceId: 'dev-a' }),
            (e: unknown) => e instanceof FeatureError && e.code === 'internal'
        );
        // Rien n'a été effacé : le refus vient avant.
        assert.deepEqual(repo.resets, []);

        setEngine(new SentinelEngine(createTestServiceDeps({ repo })));
        try {
            const out = await handlerFor(sentinelResetBaseline)(ctx, { deviceId: 'dev-a' });
            assert.deepEqual(out, { deviceId: 'dev-a', cleared: 3 });
            assert.deepEqual(repo.resets, ['dev-a']);
            assert.ok((repo.configs.get('dev-a')?.learning_until ?? 0) > Date.now());
            assert.equal(ctx.recorded.audits[0].action, 'sentinel.resetBaseline');
        } finally {
            setEngine(null);
        }
    });
});
