import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { z, ZodType } from 'zod';

import {
    databaseAdd,
    databaseAlertAdd,
    databaseAlertRemove,
    databaseAlertUpdate,
    databaseCount,
    databaseGet,
    databaseList,
    databaseRemove,
    databaseReorder,
    databaseUpdate
} from '../contracts/commands';
import type { DatabaseAlertRow, DatabaseRow } from '../contracts/domain';
import { PROJECTS_USAGE_PROVIDER, type ProjectsUsageProvider } from '@deveye/types/sdk';
import { FeatureError, type SdkFeatureContext } from '@deveye/types/sdk/server';
import { createTestContext } from '@deveye/types/sdk/testing';

import { databaseHandlers } from './handlers';
import type { DatabaseRepo, DatabaseWithStatsRow } from './repo';
import { nameRef } from './_shared';

/**
 * Les handlers du module, sur le harnais du SDK.
 *
 * Ce qui mérite d'être tenu, c'est ce qui ne lève nulle part quand ça se
 * dérègle : les **restrictions par élément** (une base masquée pour ce rôle
 * disparaît de la liste et du compte), le **partage inter-espaces** (une
 * projection se liste avec `foreign: true` sous le codec de son espace
 * d'origine, ses alertes sont celles du domicile, et elle ne se modifie
 * jamais depuis la fenêtre), le **contrat de Projets** (le compte et la liste
 * des projets viennent du provider, et son absence vaut zéro plutôt qu'une
 * erreur), la discipline des **secrets** (absent = conservé, vide = effacé,
 * jamais rendus), le **ménage** à la suppression (`ctx.items.forget`), et les
 * dernières mesures d'une alerte conservées à sa réécriture.
 */

/** Le handler d'un contrat, typé par ce contrat (le registre est hétérogène). */
function handlerFor<C extends { command: string; input: ZodType; output: ZodType }>(contract: C) {
    const def = databaseHandlers.find((h) => h.command === contract.command);
    assert.ok(def, `handler ${contract.command} manquant`);
    return def.handler as (
        ctx: SdkFeatureContext<DatabaseRepo>,
        input: z.output<C['input']>
    ) => Promise<z.input<C['output']>>;
}

const failsWith =
    (code: FeatureError['code']) =>
    (e: unknown): boolean =>
        e instanceof FeatureError && e.code === code;

interface FakeRepo extends DatabaseRepo {
    rows: DatabaseRow[];
    alerts: DatabaseAlertRow[];
}

/** Une base en base, telle que le vrai dépôt la rendrait (contenu en clair : le harnais chiffre à l'identité). */
function row(over: Partial<DatabaseRow> & { id: number; workspace_id: number }): DatabaseRow {
    const name = `Base ${over.id}`;
    return {
        engine: 'mysql',
        name_ref: nameRef(name),
        sort_order: over.id,
        monitor_enabled: 0,
        interval_seconds: 300,
        last_check_at: null,
        last_elapsed_ms: null,
        status: 'unknown',
        last_error: null,
        server_version: null,
        size_bytes: null,
        table_count: null,
        content: JSON.stringify({ name, host: 'db.exemple.fr', port: 3306, database: 'shop', username: 'ro' }),
        secret_enc: 'motdepasse',
        access_content: null,
        access_secret_enc: null,
        created: 1,
        ...over
    };
}

function alert(
    over: Partial<DatabaseAlertRow> & { id: number; database_id: number; workspace_id: number }
): DatabaseAlertRow {
    return {
        enabled: 1,
        combinator: 'and',
        firing: 0,
        last_check_at: null,
        last_fired_at: null,
        last_error: null,
        content: JSON.stringify({
            name: `Alerte ${over.id}`,
            conditions: [{ sql: 'SELECT 1', comparator: 'gt', threshold: 0, label: 'n' }],
            message: 'x',
            lastValues: [7]
        }),
        created: 1,
        ...over
    };
}

/**
 * Un dépôt en mémoire, même contrat que le vrai. `projections` reproduit la
 * table `item_shares` : `databaseId → espaces où elle est projetée`, ce qui
 * donne à `listVisible` / `findVisible` leur seconde branche, et ce que le
 * harnais (`shares`) doit dire en écho pour que `ctx.sharing.scope()`
 * connaisse le domicile.
 */
function fakeRepo(projections: Record<number, number[]> = {}): FakeRepo {
    let seq = 100;
    const rows: DatabaseRow[] = [];
    const alerts: DatabaseAlertRow[] = [];
    const visible = (r: DatabaseRow, workspaceId: number) =>
        r.workspace_id === workspaceId || (projections[r.id] ?? []).includes(workspaceId);
    const withStats = (r: DatabaseRow): DatabaseWithStatsRow => ({
        ...r,
        alert_count: alerts.filter((a) => a.database_id === r.id).length,
        firing_count: alerts.filter((a) => a.database_id === r.id && a.firing === 1).length
    });
    const unused = async () => {
        throw new Error('non attendu ici');
    };
    return {
        rows,
        alerts,
        list: async (workspaceId) => rows.filter((r) => r.workspace_id === workspaceId).map(withStats),
        listVisible: async (workspaceId) => rows.filter((r) => visible(r, workspaceId)).map(withStats),
        find: async (id, workspaceId) => rows.find((r) => r.id === id && r.workspace_id === workspaceId) ?? null,
        findVisible: async (id, workspaceId) => rows.find((r) => r.id === id && visible(r, workspaceId)) ?? null,
        findWithStats: async (id, workspaceId) => {
            const r = rows.find((x) => x.id === id && x.workspace_id === workspaceId);
            return r ? withStats(r) : null;
        },
        findVisibleWithStats: async (id, workspaceId) => {
            const r = rows.find((x) => x.id === id && visible(x, workspaceId));
            return r ? withStats(r) : null;
        },
        findByName: async (workspaceId, ref) =>
            rows.find((r) => r.workspace_id === workspaceId && r.name_ref === ref) ?? null,
        count: async (workspaceId) => rows.filter((r) => r.workspace_id === workspaceId).length,
        async create(input) {
            const created = row({
                id: ++seq,
                workspace_id: input.workspaceId,
                engine: input.engine,
                name_ref: input.nameRef,
                content: input.content,
                secret_enc: input.secretEnc,
                access_content: input.accessContent,
                access_secret_enc: input.accessSecretEnc,
                monitor_enabled: input.monitorEnabled ? 1 : 0,
                interval_seconds: input.intervalSeconds
            });
            rows.push(created);
            return created;
        },
        async update(id, workspaceId, input) {
            const target = rows.find((r) => r.id === id && r.workspace_id === workspaceId);
            if (!target) return null;
            Object.assign(target, {
                name_ref: input.nameRef,
                content: input.content,
                access_content: input.accessContent,
                monitor_enabled: input.monitorEnabled ? 1 : 0,
                interval_seconds: input.intervalSeconds
            });
            if (input.secretEnc !== undefined) target.secret_enc = input.secretEnc;
            if (input.accessSecretEnc !== undefined) target.access_secret_enc = input.accessSecretEnc;
            return target;
        },
        async remove(id, workspaceId) {
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
        recordCheck: unused,
        listDue: async () => [],
        listAlerts: async (databaseId, workspaceId) =>
            alerts.filter((a) => a.database_id === databaseId && a.workspace_id === workspaceId),
        listEnabledAlerts: unused,
        findAlert: async (alertId, workspaceId) =>
            alerts.find((a) => a.id === alertId && a.workspace_id === workspaceId) ?? null,
        async createAlert(input) {
            const created = alert({
                id: ++seq,
                database_id: input.databaseId,
                workspace_id: input.workspaceId,
                enabled: input.enabled ? 1 : 0,
                combinator: input.combinator,
                content: input.content
            });
            alerts.push(created);
            return created;
        },
        async updateAlert(alertId, workspaceId, input) {
            const target = alerts.find((a) => a.id === alertId && a.workspace_id === workspaceId);
            if (!target) return null;
            Object.assign(target, {
                enabled: input.enabled ? 1 : 0,
                combinator: input.combinator,
                content: input.content
            });
            return target;
        },
        async removeAlert(alertId, workspaceId) {
            const i = alerts.findIndex((a) => a.id === alertId && a.workspace_id === workspaceId);
            if (i === -1) return false;
            alerts.splice(i, 1);
            return true;
        },
        recordAlertCheck: unused
    };
}

function seed(repo: FakeRepo, ...seeded: DatabaseRow[]): FakeRepo {
    repo.rows.push(...seeded);
    return repo;
}

/** Le contrat de Projets, tel que l'app (ou son module) l'offre : l'espace 1 relie la base 1 à deux projets. */
const projects: ProjectsUsageProvider = {
    usageOf: async (feature, itemId, workspaceId) =>
        feature === 'database' && itemId === 1 && workspaceId === 1
            ? [
                  { projectId: 5, title: 'Boutique', status: 'active' },
                  { projectId: 6, title: 'Sans titre', status: 'draft' }
              ]
            : [],
    countByItem: async (feature, workspaceId) =>
        feature === 'database' && workspaceId === 1 ? new Map([[1, 2]]) : new Map()
};

const ACCESS = { kind: 'direct' as const, host: '', port: null, username: '', auth: 'password' as const };

/** Le brouillon complet qu'attend `database.update` (le contrat prend la base entière). */
const DRAFT = {
    name: 'Prod renommée',
    host: 'db2.exemple.fr',
    port: 3307,
    database: 'shop',
    username: 'rw',
    access: ACCESS,
    monitorEnabled: true,
    intervalSeconds: 600,
    autoLoadTables: true
};

describe('database.count et database.list', () => {
    it('retirent une base masquée pour ce rôle, et comptent les projets par le contrat de Projets', async () => {
        const repo = seed(
            fakeRepo(),
            row({ id: 1, workspace_id: 1 }),
            row({ id: 2, workspace_id: 1, secret_enc: null }),
            row({ id: 3, workspace_id: 1 })
        );
        const ctx = createTestContext({
            repo,
            itemRestrictions: { 3: 'none' },
            providers: { [PROJECTS_USAGE_PROVIDER]: projects }
        });

        const listed = await handlerFor(databaseList)(ctx, {});
        assert.deepEqual(
            listed.databases.map((d) => [d.id, d.name, d.foreign, d.hasPassword, d.projectCount]),
            [
                [1, 'Base 1', false, true, 2],
                [2, 'Base 2', false, false, 0]
            ]
        );
        // La carte compte ce que la liste montre, restrictions déduites.
        assert.deepEqual(await handlerFor(databaseCount)(ctx, {}), { count: 2 });
    });

    it('sans contrat de Projets, le compte vaut zéro plutôt qu’une erreur', async () => {
        const repo = seed(fakeRepo(), row({ id: 1, workspace_id: 1 }));
        const listed = await handlerFor(databaseList)(createTestContext({ repo }), {});
        assert.equal(listed.databases[0].projectCount, 0);
    });
});

describe('le partage inter-espaces', () => {
    it("liste une projection avec sa pastille `foreign`, sous le codec de son espace d'origine", async () => {
        // La base 7 vit dans l'espace 42 et se projette vers l'espace 1.
        const repo = seed(fakeRepo({ 7: [1] }), row({ id: 7, workspace_id: 42 }));
        const ctx = createTestContext({ repo, workspaceId: 1, shares: { 7: 42 } });

        // Le codec est demandé pour la ligne : le harnais rend l'identité,
        // l'appel est ce qui se vérifie.
        const asked: number[] = [];
        const scope = ctx.sharing.scope;
        ctx.sharing = {
            scope: async () => {
                const real = await scope();
                return {
                    ...real,
                    cipherFor: (itemId) => {
                        asked.push(itemId);
                        return real.cipherFor(itemId);
                    }
                };
            }
        };
        const listed = await handlerFor(databaseList)(ctx, {});
        assert.deepEqual(
            listed.databases.map((d) => [d.id, d.foreign]),
            [[7, true]]
        );
        assert.deepEqual(asked, [7]);
    });

    it('ouvre la fiche d’une projection avec les alertes de son domicile, et les projets d’ici', async () => {
        const repo = seed(fakeRepo({ 7: [1] }), row({ id: 7, workspace_id: 42 }));
        repo.alerts.push(alert({ id: 70, database_id: 7, workspace_id: 42 }));
        const ctx = createTestContext({
            repo,
            workspaceId: 1,
            shares: { 7: 42 },
            providers: { [PROJECTS_USAGE_PROVIDER]: projects }
        });

        const out = await handlerFor(databaseGet)(ctx, { databaseId: 7 });
        assert.equal(out.database.foreign, true);
        assert.equal(out.database.alertCount, 1);
        assert.deepEqual(
            out.alerts.map((a) => [a.id, a.name, a.lastValues]),
            [[70, 'Alerte 70', [7]]]
        );
        // Les projets listés sont ceux de l'espace APPELANT : aucun ici.
        assert.deepEqual(out.usage, []);
        assert.equal(out.database.projectCount, 0);
    });

    it('refuse de modifier une projection depuis la fenêtre', async () => {
        const repo = seed(fakeRepo({ 7: [1] }), row({ id: 7, workspace_id: 42 }));
        const ctx = createTestContext({ repo, workspaceId: 1, shares: { 7: 42 } });
        await assert.rejects(handlerFor(databaseUpdate)(ctx, { databaseId: 7, ...DRAFT }), failsWith('forbidden'));
        assert.equal(repo.rows[0].interval_seconds, 300);
    });

    it('refuse une alerte posée depuis la fenêtre sur une projection : elle serait rangée ici, inerte', async () => {
        const repo = seed(fakeRepo({ 7: [1] }), row({ id: 7, workspace_id: 42 }));
        const ctx = createTestContext({ repo, workspaceId: 1, shares: { 7: 42 } });
        await assert.rejects(
            handlerFor(databaseAlertAdd)(ctx, {
                databaseId: 7,
                name: 'Trop',
                enabled: true,
                combinator: 'and',
                conditions: [{ sql: 'SELECT 1', comparator: 'gt', threshold: 0, label: 'n' }],
                message: 'seuil'
            }),
            failsWith('forbidden')
        );
        assert.equal(repo.alerts.length, 0);
    });
});

describe('database.get', () => {
    it('rend la base, ses alertes et les projets qui la relient, avec leur titre', async () => {
        const repo = seed(fakeRepo(), row({ id: 1, workspace_id: 1 }));
        repo.alerts.push(alert({ id: 10, database_id: 1, workspace_id: 1, firing: 1 }));
        const ctx = createTestContext({ repo, providers: { [PROJECTS_USAGE_PROVIDER]: projects } });

        const out = await handlerFor(databaseGet)(ctx, { databaseId: 1 });
        assert.equal(out.database.name, 'Base 1');
        assert.equal(out.database.projectCount, 2);
        assert.deepEqual([out.database.alertCount, out.database.firingCount], [1, 1]);
        assert.deepEqual(
            out.usage.map((u) => [u.projectId, u.title, u.status]),
            [
                [5, 'Boutique', 'active'],
                [6, 'Sans titre', 'draft']
            ]
        );
        assert.equal(out.alerts[0].firing, true);
    });

    it('répond `not_found` pour une base d’un autre espace non projetée', async () => {
        const repo = seed(fakeRepo(), row({ id: 7, workspace_id: 42 }));
        await assert.rejects(
            handlerFor(databaseGet)(createTestContext({ repo, workspaceId: 1 }), { databaseId: 7 }),
            failsWith('not_found')
        );
    });
});

describe('database.add', () => {
    const body = {
        engine: 'mysql' as const,
        name: 'Prod',
        host: 'db.exemple.fr',
        port: 3306,
        database: 'shop',
        username: 'ro',
        password: 'secret',
        access: { ...ACCESS, kind: 'ssh' as const, host: 'bastion', username: 'ops', secret: 'clé' },
        monitorEnabled: false,
        intervalSeconds: 300,
        autoLoadTables: false
    };

    it('refuse un nom déjà pris dans l’espace', async () => {
        const repo = seed(fakeRepo(), row({ id: 1, workspace_id: 1, name_ref: nameRef('prod') }));
        await assert.rejects(handlerFor(databaseAdd)(createTestContext({ repo }), body), failsWith('conflict'));
        assert.equal(repo.rows.length, 1);
    });

    it('chiffre le corps et les deux secrets à l’étage ouvert, sans jamais les rendre', async () => {
        const repo = fakeRepo();
        const ctx = createTestContext({ repo });
        const out = await handlerFor(databaseAdd)(ctx, body);

        assert.equal(out.database.name, 'Prod');
        assert.equal(out.database.hasPassword, true);
        assert.equal(out.database.access.hasSecret, true);
        assert.equal(out.database.access.kind, 'ssh');
        assert.equal(out.database.projectCount, 0);
        assert.ok(!('password' in out.database));
        // Le harnais chiffre à l'identité : les secrets sont dans leurs colonnes.
        assert.equal(repo.rows[0].secret_enc, 'secret');
        assert.equal(repo.rows[0].access_secret_enc, 'clé');
        assert.equal(repo.rows[0].name_ref, nameRef('Prod'));
        assert.deepEqual(
            ctx.recorded.audits.map((a) => a.action),
            ['database.add']
        );
    });
});

describe('database.update', () => {
    it('un secret absent est conservé, une chaîne vide l’efface', async () => {
        const repo = seed(fakeRepo(), row({ id: 1, workspace_id: 1, access_secret_enc: 'clé' }));
        const ctx = createTestContext({ repo });
        const update = handlerFor(databaseUpdate);

        const kept = await update(ctx, { databaseId: 1, ...DRAFT });
        assert.equal(kept.database.hasPassword, true);
        assert.equal(kept.database.access.hasSecret, true);
        assert.equal(kept.database.name, 'Prod renommée');
        assert.equal(repo.rows[0].secret_enc, 'motdepasse');
        assert.equal(repo.rows[0].interval_seconds, 600);

        const cleared = await update(ctx, { databaseId: 1, ...DRAFT, password: '', access: { ...ACCESS, secret: '' } });
        assert.equal(cleared.database.hasPassword, false);
        assert.equal(cleared.database.access.hasSecret, false);
        assert.equal(repo.rows[0].secret_enc, null);
        assert.equal(repo.rows[0].access_secret_enc, null);

        const changed = await update(ctx, { databaseId: 1, ...DRAFT, password: 'nouveau' });
        assert.equal(changed.database.hasPassword, true);
        assert.equal(repo.rows[0].secret_enc, 'nouveau');
    });

    it('refuse le nom d’une autre base, et accepte le sien', async () => {
        const repo = seed(
            fakeRepo(),
            row({ id: 1, workspace_id: 1 }),
            row({ id: 2, workspace_id: 1, name_ref: nameRef('Prod renommée') })
        );
        const ctx = createTestContext({ repo });
        await assert.rejects(handlerFor(databaseUpdate)(ctx, { databaseId: 1, ...DRAFT }), failsWith('conflict'));
        const same = await handlerFor(databaseUpdate)(ctx, { databaseId: 2, ...DRAFT });
        assert.equal(same.database.id, 2);
    });
});

describe('database.remove et database.reorder', () => {
    it('supprimer fait le ménage des projections, restrictions et route', async () => {
        const repo = seed(fakeRepo(), row({ id: 1, workspace_id: 1 }));
        const ctx = createTestContext({ repo });
        assert.deepEqual(await handlerFor(databaseRemove)(ctx, { databaseId: 1 }), { databaseId: 1 });
        assert.deepEqual(repo.rows, []);
        assert.deepEqual(ctx.forgotten, [1]);
        assert.equal(ctx.recorded.audits[0].action, 'database.remove');

        await assert.rejects(handlerFor(databaseRemove)(ctx, { databaseId: 1 }), failsWith('not_found'));
    });

    it('range les bases dans l’ordre donné', async () => {
        const repo = seed(fakeRepo(), row({ id: 1, workspace_id: 1 }), row({ id: 2, workspace_id: 1 }));
        assert.deepEqual(await handlerFor(databaseReorder)(createTestContext({ repo }), { ids: [2, 1] }), {
            ids: [2, 1]
        });
        assert.deepEqual(
            repo.rows.map((r) => [r.id, r.sort_order]),
            [
                [1, 1],
                [2, 0]
            ]
        );
    });
});

describe('les alertes', () => {
    const draft = {
        name: 'Trop d’erreurs',
        enabled: true,
        combinator: 'or' as const,
        conditions: [
            { sql: 'SELECT COUNT(*) FROM erreurs', comparator: 'gt' as const, threshold: 5, label: 'erreurs' }
        ],
        message: 'Déjà {erreurs} erreurs'
    };

    it('ajoute une alerte chiffrée, sans mesure encore', async () => {
        const repo = seed(fakeRepo(), row({ id: 1, workspace_id: 1 }));
        const out = await handlerFor(databaseAlertAdd)(createTestContext({ repo }), { databaseId: 1, ...draft });
        assert.equal(out.alert.name, 'Trop d’erreurs');
        assert.equal(out.alert.combinator, 'or');
        assert.deepEqual(out.alert.lastValues, []);
        assert.equal(out.alert.firing, false);
        assert.equal(repo.alerts[0].workspace_id, 1);
    });

    it('réécrit une alerte en conservant ses dernières mesures', async () => {
        const repo = seed(fakeRepo(), row({ id: 1, workspace_id: 1 }));
        repo.alerts.push(alert({ id: 10, database_id: 1, workspace_id: 1 }));
        const out = await handlerFor(databaseAlertUpdate)(createTestContext({ repo }), {
            alertId: 10,
            ...draft,
            enabled: false
        });
        assert.equal(out.alert.name, 'Trop d’erreurs');
        assert.equal(out.alert.enabled, false);
        assert.deepEqual(out.alert.lastValues, [7]);
        assert.equal(out.alert.conditions[0].label, 'erreurs');
    });

    it('retire une alerte, et répond `not_found` sur une alerte d’un autre espace', async () => {
        const repo = seed(fakeRepo(), row({ id: 1, workspace_id: 1 }));
        repo.alerts.push(
            alert({ id: 10, database_id: 1, workspace_id: 1 }),
            alert({ id: 11, database_id: 7, workspace_id: 42 })
        );
        const ctx = createTestContext({ repo });
        assert.deepEqual(await handlerFor(databaseAlertRemove)(ctx, { alertId: 10 }), { alertId: 10 });
        await assert.rejects(handlerFor(databaseAlertRemove)(ctx, { alertId: 11 }), failsWith('not_found'));
        assert.deepEqual(
            repo.alerts.map((a) => a.id),
            [11]
        );
    });
});
