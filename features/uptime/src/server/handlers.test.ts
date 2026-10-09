import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { z, ZodType } from 'zod';

import {
    uptimeAcceptBaseline,
    uptimeAdd,
    uptimeCheckNow,
    uptimeChecks,
    uptimeCount,
    uptimeDeployHook,
    uptimeDeploySources,
    uptimeIncidents,
    uptimeIntegrityReadings,
    uptimeList,
    uptimeRemove,
    uptimeSetEnabled,
    uptimeUpdate,
    uptimeUpdateIntegrity
} from '../contracts/commands';
import type { UptimeCheckRow, UptimeDeploySourceRow, UptimeIncidentRow, UptimeServiceRow } from '../contracts/domain';
import { DEPLOY_ITEMS_PROVIDER, type DeployItemsProvider } from '@deveye/types/sdk';
import { FeatureError, type SdkCipher, type SdkFeatureContext } from '@deveye/types/sdk/server';
import { createTestContext } from '@deveye/types/sdk/testing';

import { setMonitor } from './_shared';
import { uptimeHandlers } from './handlers';
import type { UptimeRepo } from './repo';
import type { UptimePagesRepo, UptimeStatusRepo } from './repoPages';

/**
 * Ce qui se vérifie ici ne lève nulle part ailleurs : les restrictions par
 * élément (un service masqué disparaît de la liste), le partage inter-espaces
 * (une projection se liste `foreign`, se réécrit sous le codec de son espace
 * d'origine, ne se détruit jamais depuis la fenêtre qui la voit), le ménage à
 * la suppression et l'absence d'ordonnanceur.
 */

/** Le handler d'un contrat, typé par ce contrat (le registre est hétérogène). */
function handlerFor<C extends { command: string; input: ZodType; output: ZodType }>(contract: C) {
    const def = uptimeHandlers.find((h) => h.command === contract.command);
    assert.ok(def, `handler ${contract.command} manquant`);
    return def.handler as (
        ctx: SdkFeatureContext<UptimeRepo>,
        input: z.output<C['input']>
    ) => Promise<z.input<C['output']>>;
}

interface FakeRepo extends UptimeRepo {
    rows: UptimeServiceRow[];
    sources: UptimeDeploySourceRow[];
    checks: UptimeCheckRow[];
    incidents: UptimeIncidentRow[];
}

/** Un service en base, tel que le vrai dépôt le rendrait. */
function row(over: Partial<UptimeServiceRow> & { id: number; workspace_id: number }): UptimeServiceRow {
    return {
        user_id: 1,
        content: JSON.stringify({ name: `Service ${over.id}`, url: `https://exemple.fr/${over.id}`, keyword: null }),
        method: 'GET',
        baseline_enc: null,
        integrity_interval_seconds: null,
        integrity_checked_at: null,
        integrity_failures: 0,
        integrity_verdict: null,
        integrity_pending_since: null,
        deploy_hook_hash: null,
        deploy_hook_enc: null,
        deploy_hook_at: null,
        expected_status: null,
        interval_seconds: 60,
        timeout_seconds: 10,
        failure_threshold: 2,
        retention_days: null,
        enabled: 1,
        sort_order: over.id,
        status: 'unknown',
        consecutive_failures: 0,
        last_checked_at: null,
        last_response_ms: null,
        last_http_status: null,
        last_error: null,
        created: 1,
        ...over
    };
}

/**
 * Un dépôt en mémoire, muté en place : les tests lisent `repo.rows` après coup.
 * `projections` reproduit `item_shares` (`serviceId → espaces où il est
 * projeté`), ce que le harnais (`shares`) doit dire en écho pour que
 * `ctx.sharing.scope()` connaisse le domicile.
 */
function fakeRepo(projections: Record<number, number[]> = {}): FakeRepo {
    let seq = 100;
    const rows: UptimeServiceRow[] = [];
    const sources: UptimeDeploySourceRow[] = [];
    const visible = (r: UptimeServiceRow, workspaceId: number) =>
        r.workspace_id === workspaceId || (projections[r.id] ?? []).includes(workspaceId);
    return {
        rows,
        sources,
        checks: [],
        incidents: [],
        services: {
            listByWorkspace: async (workspaceId) => rows.filter((r) => r.workspace_id === workspaceId),
            countInWorkspaces: async (workspaceIds) => rows.filter((r) => workspaceIds.includes(r.workspace_id)).length,
            listStock: async () => [],
            listVisible: async (workspaceId) => rows.filter((r) => visible(r, workspaceId)),
            findById: async (id, workspaceId) =>
                rows.find((r) => r.id === id && r.workspace_id === workspaceId) ?? null,
            findVisible: async (id, workspaceId) => rows.find((r) => r.id === id && visible(r, workspaceId)) ?? null,
            async create({ userId, workspaceId, integrityIntervalSeconds, ...config }) {
                const created = row({
                    id: ++seq,
                    workspace_id: workspaceId,
                    user_id: userId,
                    content: config.content,
                    integrity_interval_seconds: integrityIntervalSeconds,
                    method: config.method,
                    expected_status: config.expectedStatus,
                    interval_seconds: config.intervalSeconds,
                    timeout_seconds: config.timeoutSeconds,
                    failure_threshold: config.failureThreshold,
                    retention_days: config.retentionDays,
                    enabled: config.enabled ? 1 : 0
                });
                rows.push(created);
                return created;
            },
            async update(id, workspaceId, config) {
                const target = rows.find((r) => r.id === id && r.workspace_id === workspaceId);
                if (!target) return null;
                Object.assign(target, {
                    content: config.content,
                    method: config.method,
                    expected_status: config.expectedStatus,
                    interval_seconds: config.intervalSeconds,
                    timeout_seconds: config.timeoutSeconds,
                    failure_threshold: config.failureThreshold,
                    retention_days: config.retentionDays,
                    enabled: config.enabled ? 1 : 0
                });
                return target;
            },
            async setIntegrity(id, workspaceId, { content, integrityIntervalSeconds }) {
                const target = rows.find((r) => r.id === id && r.workspace_id === workspaceId);
                if (!target) return null;
                Object.assign(target, { content, integrity_interval_seconds: integrityIntervalSeconds });
                return target;
            },
            async setEnabled(id, workspaceId, enabled) {
                const target = rows.find((r) => r.id === id && r.workspace_id === workspaceId);
                if (!target) return null;
                target.enabled = enabled ? 1 : 0;
                if (enabled) target.consecutive_failures = 0;
                return target;
            },
            async delete(id, workspaceId) {
                const i = rows.findIndex((r) => r.id === id && r.workspace_id === workspaceId);
                if (i === -1) return false;
                rows.splice(i, 1);
                return true;
            },
            async reorder(workspaceId, ids) {
                ids.forEach((id, i) => {
                    const target = rows.find((r) => r.id === id && r.workspace_id === workspaceId);
                    if (target) target.sort_order = i;
                });
            },
            listDue: async () => [],
            recordProbe: async () => undefined,
            recordIntegrity: async () => undefined,
            resetIntegrity: async (id) => {
                const r = rows.find((x) => x.id === id);
                if (!r) return;
                r.baseline_enc = null;
                r.integrity_checked_at = null;
                r.integrity_failures = 0;
                r.integrity_verdict = null;
                r.integrity_pending_since = null;
            },
            listDeploySources: async (ids) => sources.filter((s) => ids.includes(s.service_id)),
            async setDeploySources(serviceId, list) {
                for (let i = sources.length - 1; i >= 0; i--)
                    if (sources[i].service_id === serviceId) sources.splice(i, 1);
                for (const s of list) sources.push({ service_id: serviceId, kind: s.kind, ref_id: s.id });
            },
            async setDeployHook(serviceId, hook) {
                const r = rows.find((x) => x.id === serviceId);
                if (!r) return;
                r.deploy_hook_hash = hook?.hash ?? null;
                r.deploy_hook_enc = hook?.enc ?? null;
                r.deploy_hook_at = null;
            },
            findByDeployHook: async (hash) => rows.find((r) => r.deploy_hook_hash === hash) ?? null,
            async markDeployHookCalled(serviceId, at) {
                const r = rows.find((x) => x.id === serviceId);
                if (r) r.deploy_hook_at = at;
            }
        },
        history: {
            addCheck: async () => undefined,
            listChecks: async () => [],
            checkStats: async () => ({
                count: 0,
                failures: 0,
                avgMs: null,
                minMs: null,
                maxMs: null,
                firstAt: null,
                lastAt: null
            }),
            rawPoints: async () => [],
            hourlyPoints: async () => [],
            dailyPoints: async () => [],
            windowStats: async () => [],
            dailyWindowStats: async () => [],
            openIncident: async () => null,
            listOpenIncidents: async () => [],
            openIncidentAt: async () => {
                throw new Error('non attendu ici');
            },
            markIncidentNotified: async () => undefined,
            closeIncident: async () => undefined,
            listIncidents: async () => [],
            addReading: async () => undefined,
            listReadings: async () => [],
            lastConformAt: async () => null,
            pruneByRetention: async () => ({ checks: 0, readings: 0 })
        },
        // Les pages de statut ont leurs propres tests (`pages.test.ts`).
        pages: {} as UptimePagesRepo,
        status: {} as UptimeStatusRepo
    };
}

function seed(repo: FakeRepo, ...seeded: UptimeServiceRow[]): FakeRepo {
    repo.rows.push(...seeded);
    return repo;
}

/** Ce qu'attend `uptime.update` : l'identité et les réglages fins, l'onglet Général entier. */
const GENERAL = {
    name: 'API renommée',
    url: 'https://exemple.fr/health',
    method: 'GET' as const,
    expectedStatus: null,
    keyword: null,
    intervalSeconds: 300,
    timeoutSeconds: 10,
    failureThreshold: 3,
    retentionDays: 30,
    enabled: true
};
/** Ce qu'attend `uptime.add` : le Général, plus l'option d'intégrité, éteinte. */
const DRAFT = { ...GENERAL, integrityIntervalSeconds: null as number | null, paths: [] as string[] };
/** Ce qu'attend `uptime.updateIntegrity` : l'onglet Intégrité entier. */
const INTEGRITY = {
    intervalSeconds: 900 as number | null,
    paths: [] as string[],
    deployAccept: false,
    deploySources: [] as { kind: 'project' | 'deploy' | 'git'; id: number }[],
    deployHook: false
};

describe('uptime.list et uptime.count : les restrictions par élément', () => {
    it("retire de la liste un service masqué pour ce rôle, plutôt que de l'y griser", async () => {
        const repo = seed(
            fakeRepo(),
            row({ id: 1, workspace_id: 1 }),
            row({ id: 2, workspace_id: 1 }),
            row({ id: 3, workspace_id: 1 })
        );
        const ctx = createTestContext({ repo, itemRestrictions: { 3: 'none' } });

        const listed = await handlerFor(uptimeList)(ctx, {});
        assert.deepEqual(
            listed.services.map((s) => s.id),
            [1, 2]
        );
        // Le harnais chiffre à l'identité : le nom revient tel quel du blob.
        assert.equal(listed.services[0].name, 'Service 1');
        assert.equal(listed.services[0].foreign, false);

        // La carte compte ce que la liste montre, restrictions déduites.
        const counted = await handlerFor(uptimeCount)(ctx, {});
        assert.deepEqual(counted, { total: 2, up: 0, down: 0 });
    });
});

describe('la pause de l’offre', () => {
    it('se lit dans la liste sans toucher au choix de l’utilisateur, et ne compte pas comme surveillé', async () => {
        const repo = seed(
            fakeRepo(),
            row({ id: 1, workspace_id: 1, status: 'up' }),
            row({ id: 2, workspace_id: 1, status: 'down' })
        );
        const ctx = createTestContext({ repo, pausedItems: { monitors: ['2'] } });

        const listed = await handlerFor(uptimeList)(ctx, {});
        assert.deepEqual(
            listed.services.map((s) => [s.id, s.enabled, s.planPaused]),
            [
                [1, true, false],
                [2, true, true]
            ]
        );
        // Son dernier état est figé : la carte d'accueil ne le compte ni en ligne, ni en panne.
        assert.deepEqual(await handlerFor(uptimeCount)(ctx, {}), { total: 1, up: 1, down: 0 });
    });

    it('refuse un test à la demande, avant toute sonde, avec l’invite de l’offre', async () => {
        setMonitor(null);
        const repo = seed(fakeRepo(), row({ id: 1, workspace_id: 1 }));
        const ctx = createTestContext({ repo, pausedItems: { monitors: ['1'] } });
        await assert.rejects(
            handlerFor(uptimeCheckNow)(ctx, { id: 1 }),
            (e: unknown) =>
                e instanceof FeatureError &&
                e.code === 'quota_exceeded' &&
                (e.details as { paused?: boolean } | undefined)?.paused === true
        );
    });
});

describe('le partage inter-espaces', () => {
    it("liste une projection avec sa pastille `foreign`, et l'écrit sous le codec de son espace d'origine", async () => {
        // Le service 7 vit dans l'espace 42 et se projette vers l'espace 1.
        const repo = seed(fakeRepo({ 7: [1] }), row({ id: 7, workspace_id: 42 }));
        const ctx = createTestContext({ repo, workspaceId: 1, shares: { 7: 42 } });

        const listed = await handlerFor(uptimeList)(ctx, {});
        assert.equal(listed.services.length, 1);
        assert.equal(listed.services[0].id, 7);
        assert.equal(listed.services[0].foreign, true);

        // Le codec est demandé pour la ligne, et la réécriture vise l'espace
        // 42 : le faux dépôt refuse (`null`) une mise à jour adressée au
        // mauvais espace, donc un `not_found` ici trahirait un codec ou un
        // espace d'ici. Le harnais rend l'identité : l'appel est vérifié.
        const asked: number[] = [];
        const scope = ctx.sharing.scope;
        ctx.sharing = {
            ...ctx.sharing,
            scope: async () => {
                const real = await scope();
                return {
                    ...real,
                    cipherFor: (itemId) => {
                        asked.push(Number(itemId));
                        return real.cipherFor(itemId);
                    }
                };
            }
        };
        const updated = await handlerFor(uptimeUpdate)(ctx, { id: 7, service: GENERAL });
        assert.equal(updated.service.name, 'API renommée');
        assert.equal(updated.service.foreign, true);
        assert.ok(asked.includes(7));
        assert.equal(repo.rows[0].workspace_id, 42);
        assert.equal(repo.rows[0].interval_seconds, 300);
    });

    it('met en pause une projection depuis la fenêtre, en écrivant chez elle', async () => {
        // La ligne du service 7 n'existe que dans l'espace 42 : viser l'espace
        // actif rendrait `not_found` pour un service pourtant sous les yeux.
        const repo = seed(fakeRepo({ 7: [1] }), row({ id: 7, workspace_id: 42 }));
        const window = createTestContext({ repo, workspaceId: 1, shares: { 7: 42 } });

        const paused = await handlerFor(uptimeSetEnabled)(window, { id: 7, enabled: false });
        assert.equal(paused.service.enabled, false);
        assert.equal(paused.service.foreign, true);
        assert.equal(repo.rows[0].workspace_id, 42);
        assert.equal(repo.rows[0].enabled, 0);
    });

    it('refuse de détruire une projection depuis la fenêtre, et fait le ménage chez elle', async () => {
        const repo = seed(fakeRepo({ 7: [1] }), row({ id: 7, workspace_id: 42 }));

        const window = createTestContext({ repo, workspaceId: 1, shares: { 7: 42 } });
        await assert.rejects(
            handlerFor(uptimeRemove)(window, { id: 7 }),
            (e: unknown) => e instanceof FeatureError && e.code === 'forbidden'
        );
        assert.equal(repo.rows.length, 1);
        assert.deepEqual(window.forgotten, []);

        // Chez lui : la ligne part, et avec elle projections, restrictions et
        // route de notification (`ctx.items.forget`).
        const home = createTestContext({ repo, workspaceId: 42 });
        assert.deepEqual(await handlerFor(uptimeRemove)(home, { id: 7 }), { id: 7 });
        assert.equal(repo.rows.length, 0);
        assert.deepEqual(home.forgotten, ['7']);
        assert.equal(home.recorded.audits[0].action, 'uptime.remove');
    });
});

describe('les journaux d’une projection', () => {
    /** Un codec qui étiquette son espace : un blob d'ailleurs ne s'ouvre pas. */
    function tagged(tag: string): SdkCipher {
        return {
            encrypt: async (plain) => `${tag}:${plain}`,
            decrypt: async (blob) => blob.slice(tag.length + 1),
            tryDecrypt: async (blob) => (blob.startsWith(`${tag}:`) ? blob.slice(tag.length + 1) : null)
        };
    }

    it('s’ouvrent sous la clé de l’espace d’origine, pas sous celle d’ici', async () => {
        const repo = seed(fakeRepo({ 7: [1] }), row({ id: 7, workspace_id: 42 }));
        repo.history.listChecks = async () => [
            { id: 1, service_id: 7, checked_at: 10, up: 0, http_status: 502, response_ms: 40, error: 'chez:Statut 502' }
        ];
        repo.history.listIncidents = async () => [
            {
                id: 1,
                service_id: 7,
                started_at: 10,
                ended_at: null,
                http_status: 502,
                error: 'chez:Statut 502',
                notified: 0
            }
        ];
        repo.history.listReadings = async () => [
            {
                id: 1,
                service_id: 7,
                checked_at: 10,
                outcome: 'failed',
                file_count: null,
                slowest_ms: null,
                detail: `chez:${JSON.stringify({ error: 'Statut HTTP 404 sur /t.js', lines: [] })}`
            }
        ];
        const ctx = createTestContext({ repo, workspaceId: 1, shares: { 7: 42 } });
        ctx.cipher = () => tagged('ici');
        const scope = ctx.sharing.scope;
        ctx.sharing = {
            ...ctx.sharing,
            scope: async () => ({ ...(await scope()), cipherFor: async () => tagged('chez') })
        };

        const filter = { since: null, failuresOnly: false };
        const { checks } = await handlerFor(uptimeChecks)(ctx, { id: 7, limit: 10, filter });
        assert.equal(checks[0].error, 'Statut 502');
        const { incidents } = await handlerFor(uptimeIncidents)(ctx, { id: 7, limit: 10 });
        assert.equal(incidents[0].error, 'Statut 502');
        const { readings } = await handlerFor(uptimeIntegrityReadings)(ctx, { id: 7, limit: 10 });
        assert.equal(readings[0].error, 'Statut HTTP 404 sur /t.js');
    });
});

describe("l'ordonnanceur", () => {
    it('répond `internal` à une sonde manuelle quand le service de fond est absent', async () => {
        setMonitor(null);
        const repo = seed(fakeRepo(), row({ id: 1, workspace_id: 1 }));
        const ctx = createTestContext({ repo });
        await assert.rejects(
            handlerFor(uptimeCheckNow)(ctx, { id: 1 }),
            (e: unknown) => e instanceof FeatureError && e.code === 'internal'
        );
    });

    it('ajoute un service en pause sans le sonder, chiffré par le codec du module', async () => {
        setMonitor(null);
        const repo = seed(fakeRepo());
        const ctx = createTestContext({ repo });
        const added = await handlerFor(uptimeAdd)(ctx, { service: { ...DRAFT, enabled: false } });
        assert.equal(added.service.enabled, false);
        assert.equal(added.service.status, 'unknown');
        // Le blob est passé par `ctx.cipher()` (identité ici) : le nom y est.
        assert.ok(repo.rows[0].content.includes('API renommée'));
        assert.equal(ctx.recorded.audits[0].action, 'uptime.add');
    });

    it('donne à un service sans cadence celle de l’offre du propriétaire', async () => {
        setMonitor(null);
        const { intervalSeconds: _omitted, ...withoutCadence } = { ...DRAFT, enabled: false };
        for (const [paid, expected] of [
            [true, 60],
            [false, 300]
        ] as const) {
            const ctx = createTestContext({ repo: seed(fakeRepo()), paid });
            const added = await handlerFor(uptimeAdd)(ctx, { service: withoutCadence });
            assert.equal(added.service.intervalSeconds, expected, `payant : ${paid}`);
        }
    });

    it('refuse un service de plus que l’offre, compté sur tous les espaces du propriétaire', async () => {
        setMonitor(null);
        const repo = seed(fakeRepo());
        const owned = repo.rows.length;
        const ctx = createTestContext({ repo, quotaLimits: { monitors: owned }, ownerWorkspaceIds: [1, 2] });
        await assert.rejects(handlerFor(uptimeAdd)(ctx, { service: { ...DRAFT, enabled: false } }), /quota/);
        assert.equal(repo.rows.length, owned);
    });
});

describe('l’option d’intégrité', () => {
    /** Un service qui relit déjà ses fichiers, avec sa référence et un écart en cours. */
    function watched(): UptimeServiceRow {
        return row({
            id: 1,
            workspace_id: 1,
            content: JSON.stringify({
                name: 'Site',
                url: 'https://exemple.fr/health',
                keyword: null,
                paths: ['/t.js']
            }),
            integrity_interval_seconds: 900,
            integrity_checked_at: 1000,
            baseline_enc: 'référence',
            integrity_verdict: 'écart'
        });
    }
    const KEEP = { ...INTEGRITY, intervalSeconds: 3600, paths: ['/t.js'] };

    it('garde la référence quand seul le rythme change', async () => {
        const repo = seed(fakeRepo(), watched());
        await handlerFor(uptimeUpdateIntegrity)(createTestContext({ repo }), { id: 1, integrity: KEEP });
        assert.equal(repo.rows[0].integrity_interval_seconds, 3600);
        assert.equal(repo.rows[0].baseline_enc, 'référence');
    });

    it('réapprend la référence quand les chemins changent, ou que l’option s’éteint, sans oublier ses chemins', async () => {
        const repo = seed(fakeRepo(), watched());
        const ctx = createTestContext({ repo });
        await handlerFor(uptimeUpdateIntegrity)(ctx, { id: 1, integrity: { ...KEEP, paths: ['/t.js', '/u.js'] } });
        assert.equal(repo.rows[0].baseline_enc, null);
        assert.equal(repo.rows[0].integrity_verdict, null);

        repo.rows[0].baseline_enc = 'référence';
        const off = await handlerFor(uptimeUpdateIntegrity)(ctx, {
            id: 1,
            integrity: { ...KEEP, intervalSeconds: null, paths: ['/t.js', '/u.js'] }
        });
        assert.equal(repo.rows[0].baseline_enc, null);
        // Grisés à l'écran, les chemins restent pour quand l'option revient.
        assert.deepEqual(off.service.paths, ['/t.js', '/u.js']);
        assert.equal(off.service.integrityIntervalSeconds, null);
        assert.equal(off.service.integrityDrift, false);
    });

    it('l’onglet Général ne touche pas à l’intégrité, sauf une adresse qui change', async () => {
        const repo = seed(fakeRepo(), watched());
        const ctx = createTestContext({ repo });
        const kept = await handlerFor(uptimeUpdate)(ctx, {
            id: 1,
            service: { ...GENERAL, url: 'https://exemple.fr/health' }
        });
        assert.equal(kept.service.integrityIntervalSeconds, 900);
        assert.deepEqual(kept.service.paths, ['/t.js']);
        assert.equal(repo.rows[0].baseline_enc, 'référence');

        await handlerFor(uptimeUpdate)(ctx, { id: 1, service: { ...GENERAL, url: 'https://exemple.fr/' } });
        assert.equal(repo.rows[0].baseline_enc, null);
        assert.deepEqual(JSON.parse(repo.rows[0].content).paths, ['/t.js']);
    });

    it('n’accepte une version que sur un service qui relit ses fichiers', async () => {
        setMonitor(null);
        const repo = seed(fakeRepo(), row({ id: 1, workspace_id: 1 }));
        await assert.rejects(
            handlerFor(uptimeAcceptBaseline)(createTestContext({ repo }), { id: 1 }),
            (e: unknown) => e instanceof FeatureError && e.code === 'validation'
        );
    });
});

describe('les sources de déploiement', () => {
    /** Un service qui relit ses fichiers. */
    const watched = () =>
        row({
            id: 1,
            workspace_id: 1,
            content: JSON.stringify({ name: 'Site', url: 'https://exemple.fr/', keyword: null, paths: [] }),
            integrity_interval_seconds: 900
        });
    const ON = { ...INTEGRITY, deployAccept: true };

    /** Déploiements : `api` (5) se lit, `web` (6) se voit sans droit, la 7 n'existe pas pour le membre. */
    const deploy: DeployItemsProvider = {
        exists: async () => true,
        labelOf: async () => null,
        list: async () => [
            { id: 5, name: 'api', detail: 'Dokploy' },
            { id: 6, name: 'web', detail: 'GitHub Actions' },
            { id: 7, name: 'secret', detail: null }
        ],
        authorize: async (id) =>
            id === 5 ? { ok: true } : id === 6 ? { ok: false, reason: 'level' } : { ok: false, reason: 'hidden' },
        activity: async () => ({ succeeded: null, inFlight: null, error: null })
    };
    const withDeploy = (repo: FakeRepo) => createTestContext({ repo, providers: { [DEPLOY_ITEMS_PROVIDER]: deploy } });

    it('enregistre une source que le membre lit, refuse les autres sans trahir celles qu’il ne voit pas', async () => {
        const repo = seed(fakeRepo(), watched());
        const ctx = withDeploy(repo);
        const saved = await handlerFor(uptimeUpdateIntegrity)(ctx, {
            id: 1,
            integrity: { ...ON, deploySources: [{ kind: 'deploy', id: 5 }] }
        });
        assert.deepEqual(saved.service.deploySources, [{ kind: 'deploy', id: 5 }]);
        assert.equal(saved.service.deployAccept, true);

        await assert.rejects(
            handlerFor(uptimeUpdateIntegrity)(ctx, {
                id: 1,
                integrity: { ...ON, paths: ['/jamais.js'], deploySources: [{ kind: 'deploy', id: 6 }] }
            }),
            (e: unknown) => e instanceof FeatureError && e.code === 'forbidden'
        );
        // Refusé avant toute écriture : le reste du réglage n'est pas passé non plus.
        assert.deepEqual(JSON.parse(repo.rows[0].content).paths, []);
        await assert.rejects(
            handlerFor(uptimeUpdateIntegrity)(ctx, {
                id: 1,
                integrity: { ...ON, deploySources: [{ kind: 'deploy', id: 7 }] }
            }),
            (e: unknown) => e instanceof FeatureError && e.code === 'not_found'
        );
        await assert.rejects(
            handlerFor(uptimeUpdateIntegrity)(createTestContext({ repo }), {
                id: 1,
                integrity: { ...ON, deploySources: [{ kind: 'git', id: 1 }] }
            }),
            (e: unknown) => e instanceof FeatureError && e.code === 'validation'
        );
        assert.deepEqual(repo.sources, [{ service_id: 1, kind: 'deploy', ref_id: 5 }]);
    });

    it('refuse d’accepter sans aucune source tant que l’option est allumée', async () => {
        const repo = seed(fakeRepo(), watched());
        const ctx = withDeploy(repo);
        await assert.rejects(
            handlerFor(uptimeUpdateIntegrity)(ctx, { id: 1, integrity: ON }),
            (e: unknown) => e instanceof FeatureError && e.code === 'validation'
        );
        const off = await handlerFor(uptimeUpdateIntegrity)(ctx, {
            id: 1,
            integrity: { ...ON, intervalSeconds: null }
        });
        assert.equal(off.service.deployAccept, true);
    });

    it('garde une source déjà en place, même hors des droits de qui enregistre', async () => {
        const repo = seed(fakeRepo(), watched());
        repo.sources.push({ service_id: 1, kind: 'deploy', ref_id: 6 });
        await handlerFor(uptimeUpdateIntegrity)(withDeploy(repo), {
            id: 1,
            integrity: { ...ON, deploySources: [{ kind: 'deploy', id: 6 }] }
        });
        assert.deepEqual(repo.sources, [{ service_id: 1, kind: 'deploy', ref_id: 6 }]);
    });

    it('éteintes, l’option et l’acceptation gardent leurs sources et l’adresse d’appel', async () => {
        const repo = seed(fakeRepo(), watched());
        const ctx = withDeploy(repo);
        const chosen = { ...ON, deploySources: [{ kind: 'deploy' as const, id: 5 }], deployHook: true };
        await handlerFor(uptimeUpdateIntegrity)(ctx, { id: 1, integrity: chosen });
        const hash = repo.rows[0].deploy_hook_hash;
        assert.notEqual(hash, null);

        const off = await handlerFor(uptimeUpdateIntegrity)(ctx, {
            id: 1,
            integrity: { ...chosen, intervalSeconds: null, deployAccept: false }
        });
        assert.deepEqual(repo.sources, [{ service_id: 1, kind: 'deploy', ref_id: 5 }]);
        assert.equal(repo.rows[0].deploy_hook_hash, hash);
        assert.equal(off.service.deployHook, true);
        assert.equal(off.service.deployAccept, false);
    });

    it('l’adresse d’appel se crée à l’enregistrement, se relit telle quelle et se régénère', async () => {
        const repo = seed(fakeRepo(), watched());
        const ctx = createTestContext({ repo });
        await assert.rejects(
            handlerFor(uptimeDeployHook)(ctx, { id: 1 }),
            (e: unknown) => e instanceof FeatureError && e.code === 'conflict'
        );
        await handlerFor(uptimeUpdateIntegrity)(ctx, { id: 1, integrity: { ...ON, deployHook: true } });

        const first = await handlerFor(uptimeDeployHook)(ctx, { id: 1 });
        assert.ok(first.url.startsWith('https://public.deveye.test/api/uptime/deployed/'));
        assert.equal((await handlerFor(uptimeDeployHook)(ctx, { id: 1 })).url, first.url);

        const hash = repo.rows[0].deploy_hook_hash;
        const renewed = await handlerFor(uptimeDeployHook)(ctx, { id: 1, regenerate: true });
        assert.notEqual(renewed.url, first.url);
        assert.notEqual(repo.rows[0].deploy_hook_hash, hash);
    });

    it('le sélecteur liste chaque catégorie même vide, grise ce qui ne se choisit pas, garde une source disparue', async () => {
        const repo = seed(fakeRepo(), watched());
        repo.sources.push({ service_id: 1, kind: 'git', ref_id: 9 });
        const res = await handlerFor(uptimeDeploySources)(withDeploy(repo), { id: 1 });
        assert.deepEqual(res.kinds, ['project', 'deploy', 'git', 'hook']);
        const brief = res.candidates.map((c) => [c.kind, c.id, c.name, c.available, c.tag]);
        assert.deepEqual(brief, [
            ['deploy', 5, 'api', true, null],
            ['deploy', 6, 'web', false, 'sans droit'],
            ['git', 9, 'Source introuvable', true, 'introuvable'],
            ['hook', null, 'Adresse d’appel de ce service', true, null]
        ]);
        assert.match(res.candidates[2].reason ?? '', /module Git/);
    });
});
