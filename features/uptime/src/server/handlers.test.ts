import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { z, ZodType } from 'zod';

import {
    uptimeAdd,
    uptimeCheckNow,
    uptimeCount,
    uptimeList,
    uptimeRemove,
    uptimeSetEnabled,
    uptimeUpdate
} from '../contracts/commands';
import type { UptimeCheckRow, UptimeIncidentRow, UptimeServiceRow } from '../contracts/domain';
import { FeatureError, type SdkFeatureContext } from '@deveye/types/sdk/server';
import { createTestContext } from '@deveye/types/sdk/testing';

import { setMonitor } from './_shared';
import { uptimeHandlers } from './handlers';
import type { UptimeRepo } from './repo';

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
    checks: UptimeCheckRow[];
    incidents: UptimeIncidentRow[];
}

/** Un service en base, tel que le vrai dépôt le rendrait. */
function row(over: Partial<UptimeServiceRow> & { id: number; workspace_id: number }): UptimeServiceRow {
    return {
        user_id: 1,
        content: JSON.stringify({ name: `Service ${over.id}`, url: `https://exemple.fr/${over.id}`, keyword: null }),
        method: 'GET',
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
    const visible = (r: UptimeServiceRow, workspaceId: number) =>
        r.workspace_id === workspaceId || (projections[r.id] ?? []).includes(workspaceId);
    return {
        rows,
        checks: [],
        incidents: [],
        services: {
            listByWorkspace: async (workspaceId) => rows.filter((r) => r.workspace_id === workspaceId),
            listVisible: async (workspaceId) => rows.filter((r) => visible(r, workspaceId)),
            findById: async (id, workspaceId) =>
                rows.find((r) => r.id === id && r.workspace_id === workspaceId) ?? null,
            findVisible: async (id, workspaceId) => rows.find((r) => r.id === id && visible(r, workspaceId)) ?? null,
            async create({ userId, workspaceId, ...config }) {
                const created = row({
                    id: ++seq,
                    workspace_id: workspaceId,
                    user_id: userId,
                    content: config.content,
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
            recordProbe: async () => undefined
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
            pruneByRetention: async () => 0
        }
    };
}

function seed(repo: FakeRepo, ...seeded: UptimeServiceRow[]): FakeRepo {
    repo.rows.push(...seeded);
    return repo;
}

/** Le brouillon complet qu'attend `uptime.update` (le contrat prend le service entier). */
const DRAFT = {
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
        const updated = await handlerFor(uptimeUpdate)(ctx, { id: 7, service: DRAFT });
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
});
