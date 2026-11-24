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
    databaseInspect,
    databaseKpiRemove,
    databaseKpiSave,
    databaseList,
    databaseQuery,
    databaseRemove,
    databaseReorder,
    databaseSetTier,
    databaseTableList,
    databaseUpdate
} from '../contracts/commands';
import type { DatabaseAlertRow, DatabaseRow } from '../contracts/domain';
import { PROJECTS_USAGE_PROVIDER, type ProjectsUsageProvider } from '@deveye/types/sdk';
import { FeatureError, type SdkFeatureContext } from '@deveye/types/sdk/server';
import { createTestContext } from '@deveye/types/sdk/testing';

import { databaseTree } from './copy';
import { databaseHandlers } from './handlers';
import { serverEntry } from './index';
import { databaseMove } from './move';
import type { DatabaseRepo, DatabaseWithStatsRow } from './repo';
import { nameRef } from './_shared';

/**
 * Les handlers du module sur le harnais du SDK : restrictions par élément,
 * partage inter-espaces, contrat de Projets, discipline des secrets, ménage à
 * la suppression, dernières mesures conservées à la réécriture d'une alerte,
 * indicateurs.
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

/** Le condensé d'un nom dans un espace, tel que les handlers le calculent sous les clés du harnais. */
const refOf = (name: string, workspaceId = 1): string => nameRef(createTestContext().keys, workspaceId, name);

/** Une ligne telle que le vrai dépôt la rendrait ; le harnais chiffre à l'identité. */
function row(over: Partial<DatabaseRow> & { id: number; workspace_id: number }): DatabaseRow {
    const name = `Base ${over.id}`;
    return {
        engine: 'mysql',
        security_tier: 'open',
        name_ref: refOf(name, over.workspace_id),
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
        kpis: null,
        kpi_values: null,
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

/** Un dépôt en mémoire ; `projections` reproduit `item_shares` (base → espaces où elle est projetée). */
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
        countInWorkspaces: async (ids: readonly number[]) => ids.length - ids.length,
        listStock: unused,
        listHome: unused,
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
                security_tier: input.securityTier,
                monitor_enabled: input.monitorEnabled ? 1 : 0,
                interval_seconds: input.intervalSeconds
            });
            rows.push(created);
            return created;
        },
        async setTier(id, workspaceId, input) {
            const target = rows.find((r) => r.id === id && r.workspace_id === workspaceId);
            if (!target) return false;
            Object.assign(target, {
                security_tier: input.securityTier,
                secret_enc: input.secretEnc,
                access_secret_enc: input.accessSecretEnc
            });
            if (input.securityTier === 'guarded') {
                target.monitor_enabled = 0;
                for (const a of alerts) if (a.database_id === id) Object.assign(a, { enabled: 0, firing: 0 });
            }
            return true;
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
        recordAlertCheck: unused,
        async saveKpis(id, workspaceId, kpis) {
            const target = rows.find((r) => r.id === id && r.workspace_id === workspaceId);
            if (!target) return false;
            target.kpis = kpis;
            return true;
        },
        async recordKpiValues(id, values) {
            const target = rows.find((r) => r.id === id);
            if (target) target.kpi_values = values;
        }
    };
}

function seed(repo: FakeRepo, ...seeded: DatabaseRow[]): FakeRepo {
    repo.rows.push(...seeded);
    return repo;
}

/** Le contrat de Projets : l'espace 1 relie la base 1 à deux projets. */
const projects: ProjectsUsageProvider = {
    usageOf: async (feature, itemId, workspaceId) =>
        feature === 'database' && itemId === 1 && workspaceId === 1
            ? [
                  { projectId: 5, title: 'Boutique', status: 'active' },
                  { projectId: 6, title: 'Sans titre', status: 'draft' }
              ]
            : [],
    countByItem: async (feature, workspaceId) =>
        feature === 'database' && workspaceId === 1 ? new Map([[1, 2]]) : new Map(),
    detach: async () => 0,
    recordEvent: async () => undefined,
    // Non sollicitées ici : l'écriture des liaisons est testée chez Projets.
    linkTargets: async () => [],
    link: async () => undefined,
    unlink: async () => undefined,
    applyVersion: async () => undefined,
    authorize: async () => ({ ok: true }),
    linkedItems: async () => ({ deploy: [], git: [] })
};

const ACCESS = {
    kind: 'direct' as const,
    host: '',
    port: null,
    username: '',
    auth: 'password' as const,
    deviceId: null
};

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

/** Le même brouillon, sur le même serveur et le même compte : les secrets enregistrés y restent valables. */
const SAME = { ...DRAFT, host: 'db.exemple.fr', port: 3306, username: 'ro' };

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

describe('la pause d’offre', () => {
    const isPausedRefusal = (e: unknown): boolean =>
        e instanceof FeatureError &&
        e.code === 'quota_exceeded' &&
        (e.details as { paused?: boolean } | undefined)?.paused === true;

    it('la liste et la fiche la disent ; relever et toute session sont refusés avant d’ouvrir quoi que ce soit', async () => {
        const repo = seed(fakeRepo(), row({ id: 1, workspace_id: 1 }), row({ id: 2, workspace_id: 1 }));
        // Sans service de relevé monté : une commande qui passerait la garde
        // lèverait `internal`, pas le refus de l'offre.
        const ctx = createTestContext({ repo, pausedItems: { connections: ['2'] } });

        const listed = await handlerFor(databaseList)(ctx, {});
        assert.deepEqual(
            listed.databases.map((d) => [d.id, d.planPaused]),
            [
                [1, false],
                [2, true]
            ]
        );
        assert.equal((await handlerFor(databaseGet)(ctx, { databaseId: 2 })).database.planPaused, true);

        await assert.rejects(handlerFor(databaseInspect)(ctx, { databaseId: 2 }), isPausedRefusal);
        await assert.rejects(handlerFor(databaseQuery)(ctx, { databaseId: 2, sql: 'SELECT 1' }), isPausedRefusal);
        await assert.rejects(handlerFor(databaseTableList)(ctx, { databaseId: 2 }), isPausedRefusal);
        await assert.rejects(handlerFor(databaseTableList)(ctx, { databaseId: 1 }), failsWith('internal'));
    });
});

describe('le partage inter-espaces', () => {
    it("liste une projection avec sa pastille `foreign`, sous le codec de son espace d'origine", async () => {
        // La base 7 vit dans l'espace 42 et se projette vers l'espace 1.
        const repo = seed(fakeRepo({ 7: [1] }), row({ id: 7, workspace_id: 42 }));
        const ctx = createTestContext({ repo, workspaceId: 1, shares: { 7: 42 } });

        // Le harnais rend l'identité : c'est l'appel qui se vérifie.
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
        securityTier: 'open' as const,
        monitorEnabled: false,
        intervalSeconds: 300,
        autoLoadTables: false
    };

    it('refuse un nom déjà pris dans l’espace', async () => {
        const repo = seed(fakeRepo(), row({ id: 1, workspace_id: 1, name_ref: refOf('prod') }));
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
        assert.equal(repo.rows[0].name_ref, refOf('Prod'));
        assert.deepEqual(
            ctx.recorded.audits.map((a) => a.action),
            ['database.add']
        );
    });
});

describe('l’accès par un appareil', () => {
    const deviceId = '5b0f3c1e-8d2a-4f6b-9c7e-1a2b3c4d5e6f';
    const body = {
        engine: 'postgres' as const,
        name: 'Locale',
        host: '127.0.0.1',
        port: 5432,
        database: 'app',
        username: 'dev',
        password: '',
        access: { ...ACCESS, kind: 'device' as const, deviceId },
        securityTier: 'open' as const,
        monitorEnabled: false,
        intervalSeconds: 300,
        autoLoadTables: false
    };

    it('exige d’ouvrir le réseau de l’appareil, et retient qui l’a choisi', async () => {
        const refused = createTestContext({ repo: fakeRepo(), refuseDeviceExtras: true });
        await assert.rejects(handlerFor(databaseAdd)(refused, body), failsWith('forbidden'));
        await assert.rejects(
            handlerFor(databaseAdd)(createTestContext({ repo: fakeRepo() }), {
                ...body,
                access: { ...body.access, deviceId: null }
            }),
            failsWith('validation')
        );

        const repo = fakeRepo();
        const out = await handlerFor(databaseAdd)(createTestContext({ repo, userId: 7 }), body);
        assert.equal(out.database.access.kind, 'device');
        assert.equal(out.database.access.deviceId, deviceId);
        assert.deepEqual(JSON.parse(repo.rows[0].access_content ?? ''), {
            kind: 'device',
            host: '',
            port: null,
            username: '',
            auth: 'password',
            deviceId,
            authorUserId: 7
        });
    });

    it('un autre mode d’accès ne retient ni appareil ni auteur', async () => {
        const repo = fakeRepo();
        await handlerFor(databaseAdd)(createTestContext({ repo, userId: 7 }), {
            ...body,
            access: { ...ACCESS, deviceId }
        });
        const stored = JSON.parse(repo.rows[0].access_content ?? '');
        assert.equal(stored.deviceId, null);
        assert.equal(stored.authorUserId, null);
    });
});

describe('database.update', () => {
    it('un secret absent est conservé, une chaîne vide l’efface', async () => {
        const repo = seed(fakeRepo(), row({ id: 1, workspace_id: 1, access_secret_enc: 'clé' }));
        const ctx = createTestContext({ repo });
        const update = handlerFor(databaseUpdate);

        const kept = await update(ctx, { databaseId: 1, ...SAME });
        assert.equal(kept.database.hasPassword, true);
        assert.equal(kept.database.access.hasSecret, true);
        assert.equal(kept.database.name, 'Prod renommée');
        assert.equal(repo.rows[0].secret_enc, 'motdepasse');
        assert.equal(repo.rows[0].interval_seconds, 600);

        // Un secret gardé ne suit pas la base ailleurs : sinon, changer l'hôte
        // suffirait à le faire présenter à un serveur de son choix.
        await assert.rejects(update(ctx, { databaseId: 1, ...DRAFT }), failsWith('validation'));
        await assert.rejects(
            update(ctx, { databaseId: 1, ...SAME, password: 'x', access: { ...ACCESS, kind: 'ssh', host: 'rebond' } }),
            failsWith('validation')
        );

        const cleared = await update(ctx, { databaseId: 1, ...DRAFT, password: '', access: { ...ACCESS, secret: '' } });
        assert.equal(cleared.database.hasPassword, false);
        assert.equal(cleared.database.access.hasSecret, false);
        assert.equal(repo.rows[0].secret_enc, null);
        assert.equal(repo.rows[0].access_secret_enc, null);

        const changed = await update(ctx, { databaseId: 1, ...DRAFT, password: 'nouveau' });
        assert.equal(changed.database.hasPassword, true);
        assert.equal(repo.rows[0].secret_enc, 'nouveau');
    });

    it('les tables se chargent dès leur affichage, sauf refus enregistré', async () => {
        const repo = seed(fakeRepo(), row({ id: 1, workspace_id: 1 }));
        const ctx = createTestContext({ repo });
        const update = handlerFor(databaseUpdate);

        // Un corps qui n'en dit rien vaut le défaut.
        assert.equal((await handlerFor(databaseGet)(ctx, { databaseId: 1 })).database.autoLoadTables, true);
        assert.equal(
            (await update(ctx, { databaseId: 1, ...SAME, autoLoadTables: false })).database.autoLoadTables,
            false
        );
        assert.equal(
            (await update(ctx, { databaseId: 1, ...SAME, autoLoadTables: true })).database.autoLoadTables,
            true
        );
    });

    it('refuse le nom d’une autre base, et accepte le sien', async () => {
        const repo = seed(
            fakeRepo(),
            row({ id: 1, workspace_id: 1 }),
            row({ id: 2, workspace_id: 1, name_ref: refOf('Prod renommée') })
        );
        const ctx = createTestContext({ repo });
        await assert.rejects(handlerFor(databaseUpdate)(ctx, { databaseId: 1, ...SAME }), failsWith('conflict'));
        const same = await handlerFor(databaseUpdate)(ctx, { databaseId: 2, ...SAME });
        assert.equal(same.database.id, 2);
    });
});

describe('database.remove et database.reorder', () => {
    it('supprimer fait le ménage des projections, restrictions et route', async () => {
        const repo = seed(fakeRepo(), row({ id: 1, workspace_id: 1 }));
        const ctx = createTestContext({ repo });
        assert.deepEqual(await handlerFor(databaseRemove)(ctx, { databaseId: 1 }), { databaseId: 1 });
        assert.deepEqual(repo.rows, []);
        assert.deepEqual(ctx.forgotten, ['1']);
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

describe('les indicateurs', () => {
    const stored = (id: string, sql: string) => ({ id, label: `Indicateur ${id}`, sql, unit: '' });

    it('ajoute un indicateur et le mesure aussitôt ; une session impossible laisse sa raison à la tuile', async () => {
        const repo = seed(fakeRepo(), row({ id: 1, workspace_id: 1 }));
        // Sans service de relevé monté, aucune session ne s'ouvre.
        const ctx = createTestContext({ repo });
        const out = await handlerFor(databaseKpiSave)(ctx, {
            databaseId: 1,
            label: ' Commandes ',
            sql: ' SELECT COUNT(*) FROM commandes ',
            unit: ''
        });
        assert.equal(out.kpi.label, 'Commandes');
        assert.equal(out.kpi.sql, 'SELECT COUNT(*) FROM commandes');
        assert.equal(out.kpi.value, null);
        assert.ok(out.kpi.error);
        const got = await handlerFor(databaseGet)(ctx, { databaseId: 1 });
        assert.deepEqual(
            got.kpis.map((k) => [k.id, k.label, k.error === out.kpi.error]),
            [[out.kpi.id, 'Commandes', true]]
        );
    });

    it('ne montre que la mesure de la requête actuelle', async () => {
        const repo = seed(
            fakeRepo(),
            row({
                id: 1,
                workspace_id: 1,
                kpis: JSON.stringify([stored('a', 'SELECT 1'), stored('b', 'SELECT 3')]),
                kpi_values: JSON.stringify({
                    a: { sql: 'SELECT 1', value: 142, error: null, at: 5 },
                    b: { sql: 'SELECT 2', value: 9, error: null, at: 5 }
                })
            })
        );
        const got = await handlerFor(databaseGet)(createTestContext({ repo }), { databaseId: 1 });
        assert.deepEqual(
            got.kpis.map((k) => [k.id, k.value, k.measuredAt]),
            [
                ['a', 142, 5],
                ['b', null, null]
            ]
        );
    });

    it('en tient huit au plus, et refuse une projection : elle serait scellée ici', async () => {
        const full = Array.from({ length: 8 }, (_, i) => stored(String(i), 'SELECT 1'));
        const repo = seed(
            fakeRepo({ 7: [1] }),
            row({ id: 1, workspace_id: 1, kpis: JSON.stringify(full) }),
            row({ id: 7, workspace_id: 42 })
        );
        const draft = { label: 'Stock', sql: 'SELECT MIN(stock) FROM produits', unit: '' };
        await assert.rejects(
            handlerFor(databaseKpiSave)(createTestContext({ repo }), { databaseId: 1, ...draft }),
            failsWith('validation')
        );
        const window = createTestContext({ repo, workspaceId: 1, shares: { 7: 42 } });
        await assert.rejects(handlerFor(databaseKpiSave)(window, { databaseId: 7, ...draft }), failsWith('forbidden'));
        assert.equal(repo.rows[1].kpis, null);
    });

    it('réécrit un indicateur à sa place, et le retire', async () => {
        const repo = seed(
            fakeRepo(),
            row({ id: 1, workspace_id: 1, kpis: JSON.stringify([stored('a', 'SELECT 1'), stored('b', 'SELECT 2')]) })
        );
        const ctx = createTestContext({ repo });
        await handlerFor(databaseKpiSave)(ctx, {
            databaseId: 1,
            kpiId: 'a',
            label: 'Ventes',
            sql: 'SELECT 4',
            unit: '€'
        });
        await assert.rejects(
            handlerFor(databaseKpiSave)(ctx, { databaseId: 1, kpiId: 'z', label: 'x', sql: 'SELECT 1', unit: '' }),
            failsWith('not_found')
        );
        assert.deepEqual(await handlerFor(databaseKpiRemove)(ctx, { databaseId: 1, kpiId: 'b' }), { kpiId: 'b' });
        const got = await handlerFor(databaseGet)(ctx, { databaseId: 1 });
        assert.deepEqual(
            got.kpis.map((k) => [k.id, k.label, k.sql, k.unit]),
            [['a', 'Ventes', 'SELECT 4', '€']]
        );
        await assert.rejects(handlerFor(databaseKpiRemove)(ctx, { databaseId: 1, kpiId: 'b' }), failsWith('not_found'));
    });
});

describe('une base protégée par mot de passe', () => {
    const body = {
        engine: 'mysql' as const,
        name: 'Compta',
        host: 'db.exemple.fr',
        port: 3306,
        database: 'compta',
        username: 'ro',
        password: 'secret',
        access: ACCESS,
        securityTier: 'guarded' as const,
        monitorEnabled: false,
        intervalSeconds: 300,
        autoLoadTables: true
    };
    const guarded = (over: Partial<DatabaseRow> = {}) =>
        row({ id: 1, workspace_id: 1, security_tier: 'guarded', secret_enc: 'secret', ...over });
    const alertDraft = {
        name: 'Trop d’erreurs',
        enabled: true,
        combinator: 'or' as const,
        conditions: [{ sql: 'SELECT COUNT(*) FROM erreurs', comparator: 'gt' as const, threshold: 5, label: 'e' }],
        message: 'Déjà {e} erreurs'
    };

    it('ne naît que là où le mot de passe garde vraiment la clé, et sans relevé', async () => {
        const add = handlerFor(databaseAdd);
        const shared = createTestContext({ repo: fakeRepo(), kind: 'shared' });
        await assert.rejects(add(shared, body), /n’existe que dans votre espace personnel/);
        const unprotected = createTestContext({ repo: fakeRepo(), passwordProtected: false });
        await assert.rejects(add(unprotected, body), /Activez d’abord le chiffrement par mot de passe/);
        await assert.rejects(
            add(createTestContext({ repo: fakeRepo() }), { ...body, monitorEnabled: true }),
            /ni relevé automatique ni alerte/
        );
        // Ses secrets s'écrivent sous la clé de la session : verrouillée, rien ne s'écrit.
        const locked = fakeRepo();
        await assert.rejects(add(createTestContext({ repo: locked, unlocked: false }), body), failsWith('locked'));
        assert.equal(locked.rows.length, 0);

        const repo = fakeRepo();
        const out = await add(createTestContext({ repo }), body);
        assert.equal(out.database.securityTier, 'guarded');
        assert.equal(repo.rows[0].security_tier, 'guarded');
        assert.equal(out.database.monitorEnabled, false);
    });

    it('se liste et s’ouvre session verrouillée, mais ne se joint qu’une fois déverrouillée', async () => {
        const repo = seed(fakeRepo(), guarded());
        const locked = createTestContext({ repo, unlocked: false });
        assert.equal((await handlerFor(databaseList)(locked, {})).databases[0].securityTier, 'guarded');
        assert.equal((await handlerFor(databaseGet)(locked, { databaseId: 1 })).database.name, 'Base 1');
        await assert.rejects(handlerFor(databaseInspect)(locked, { databaseId: 1 }), failsWith('locked'));
        await assert.rejects(
            handlerFor(databaseQuery)(locked, { databaseId: 1, sql: 'SELECT 1' }),
            failsWith('locked')
        );
        await assert.rejects(handlerFor(databaseTableList)(locked, { databaseId: 1 }), failsWith('locked'));
        // Déverrouillée, la garde passe : sans service monté, c'est lui qui manque.
        const unlocked = createTestContext({ repo });
        await assert.rejects(handlerFor(databaseTableList)(unlocked, { databaseId: 1 }), failsWith('internal'));
    });

    it('refuse le relevé automatique et toute alerte active', async () => {
        const repo = seed(fakeRepo(), guarded());
        const ctx = createTestContext({ repo });
        await assert.rejects(
            handlerFor(databaseUpdate)(ctx, { databaseId: 1, ...SAME, name: 'Base 1' }),
            /ni relevé automatique ni alerte/
        );
        await assert.rejects(
            handlerFor(databaseAlertAdd)(ctx, { databaseId: 1, ...alertDraft }),
            /ni relevé automatique ni alerte/
        );
        // Une alerte restée de l'époque ouverte se retouche éteinte, pas allumée.
        const { alert: kept } = await handlerFor(databaseAlertAdd)(
            createTestContext({ repo: seed(repo, row({ id: 2, workspace_id: 1 })) }),
            { databaseId: 2, ...alertDraft }
        );
        repo.alerts[0].database_id = 1;
        await assert.rejects(
            handlerFor(databaseAlertUpdate)(ctx, { alertId: kept.id, ...alertDraft }),
            /ni relevé automatique ni alerte/
        );
        const off = await handlerFor(databaseAlertUpdate)(ctx, { alertId: kept.id, ...alertDraft, enabled: false });
        assert.equal(off.alert.enabled, false);
    });

    it('changer d’étage rechiffre les secrets, arrête le relevé et éteint les alertes', async () => {
        const repo = seed(fakeRepo(), row({ id: 1, workspace_id: 1, monitor_enabled: 1, secret_enc: 'secret' }));
        await handlerFor(databaseAlertAdd)(createTestContext({ repo }), { databaseId: 1, ...alertDraft });
        const setTier = handlerFor(databaseSetTier);
        const to = { databaseId: 1, securityTier: 'guarded' as const };

        await assert.rejects(setTier(createTestContext({ repo, kind: 'shared' }), to), failsWith('validation'));
        await assert.rejects(
            setTier(createTestContext({ repo, passwordProtected: false }), to),
            /Activez d’abord le chiffrement par mot de passe/
        );
        // Il faut la clé du mot de passe pour écrire sous elle.
        await assert.rejects(setTier(createTestContext({ repo, unlocked: false }), to), failsWith('locked'));
        assert.equal(repo.rows[0].security_tier, 'open');

        const ctx = createTestContext({ repo });
        const out = await setTier(ctx, to);
        assert.equal(out.database.securityTier, 'guarded');
        assert.equal(out.database.monitorEnabled, false);
        assert.equal(out.database.hasPassword, true);
        assert.deepEqual(
            repo.alerts.map((a) => [a.enabled, a.firing]),
            [[0, 0]]
        );
        assert.deepEqual(
            ctx.recorded.audits.map((a) => a.action),
            ['database.tier']
        );

        // Le retour demande lui aussi la session : on relit sous la clé qu'on quitte.
        const back = { databaseId: 1, securityTier: 'open' as const };
        await assert.rejects(setTier(createTestContext({ repo, unlocked: false }), back), failsWith('locked'));
        assert.equal((await setTier(createTestContext({ repo }), back)).database.securityTier, 'open');
        // Ni le relevé ni les alertes ne se rallument seuls.
        assert.equal(repo.rows[0].monitor_enabled, 0);
        assert.equal(repo.alerts[0].enabled, 0);
    });

    it('ne se règle pas depuis une fenêtre, et le même étage ne réécrit rien', async () => {
        const repo = seed(fakeRepo({ 7: [1] }), row({ id: 7, workspace_id: 42 }), row({ id: 1, workspace_id: 1 }));
        const ctx = createTestContext({ repo, workspaceId: 1, shares: { 7: 42 } });
        await assert.rejects(
            handlerFor(databaseSetTier)(ctx, { databaseId: 7, securityTier: 'guarded' }),
            failsWith('forbidden')
        );
        const same = await handlerFor(databaseSetTier)(ctx, { databaseId: 1, securityTier: 'open' });
        assert.equal(same.database.securityTier, 'open');
        assert.deepEqual(ctx.recorded.audits, []);
    });

    it('ne se partage pas, ne se déplace pas, et sa copie arrive ouverte', async () => {
        const repo = seed(fakeRepo(), guarded(), row({ id: 2, workspace_id: 1 }));
        assert.equal(await serverEntry.items?.shareable?.(repo, '1', 1), false);
        assert.equal(await serverEntry.items?.shareable?.(repo, '2', 1), true);

        const q = {
            query: async <T extends object>(sql: string, params: unknown[] = []) =>
                (sql.includes("security_tier = 'guarded'")
                    ? [{ n: repo.rows.some((r) => r.id === params[0] && r.security_tier === 'guarded') ? 1 : 0 }]
                    : []) as unknown as T[],
            execute: async () => ({ affectedRows: 0, insertId: 0 })
        };
        const { keys } = createTestContext();
        const cipher = createTestContext().cipher();
        const plan = (itemId: string) =>
            databaseMove.plan({ q, repo, itemId, fromWorkspaceId: 1, toWorkspaceId: 2, cipher, keys });
        assert.match((await plan('1')).blockers[0], /ne change pas d’espace/);
        assert.deepEqual((await plan('2')).blockers, []);

        // L'étage ne voyage pas plus que les secrets : la copie naît ouverte.
        const [root] = databaseTree;
        for (const column of ['security_tier', 'secret_enc', 'access_secret_enc']) {
            assert.ok(root.omit?.includes(column), `${column} ne voyage pas`);
        }
    });
});
