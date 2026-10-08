import assert from 'node:assert/strict';
import { createServer, type AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';

import type { DatabaseAlertRow, DatabaseRow, DatabaseRows } from '../contracts/domain';
import {
    DATABASE_BACKUP_PROVIDER,
    DATABASE_ITEMS_PROVIDER,
    DATABASE_MEASURE_PROVIDER,
    type DatabaseBackupProvider,
    type DatabaseItemsProvider,
    type DatabaseMeasureProvider
} from '@deveye/types/sdk';
import { createTestServiceDeps, testDevice } from '@deveye/types/sdk/testing';

// L'accès d'une sauvegarde ouvre un vrai relais : le test lui donne une base
// en boucle locale, que le garde des connexions sortantes refuse par défaut.
import { setAllowPrivateForTest } from '@/Services/netFetch';

import type { Inventory, Session } from './engine';
import { serverEntry } from './index';
import type { DatabaseRepo } from './repo';
import { DatabaseMonitor } from './service';

/**
 * Le relevé périodique sur le harnais du SDK, session injectée : un échec
 * conserve version et taille, les alertes notifient aux transitions seulement,
 * `last_fired_at` n'est posé qu'à la montée, une alerte cassée n'arrête pas les autres.
 */

interface FakeRepo extends DatabaseRepo {
    rows: DatabaseRow[];
    alerts: DatabaseAlertRow[];
    /** Chaque écriture d'état d'alerte, dans l'ordre. */
    alertChecks: { alertId: number; firing: boolean; firedAt: number | null; error: string | null }[];
}

function row(over: Partial<DatabaseRow> = {}): DatabaseRow {
    return {
        id: 1,
        workspace_id: 1,
        engine: 'mysql',
        name_ref: 'prod',
        sort_order: 0,
        monitor_enabled: 1,
        interval_seconds: 0,
        last_check_at: null,
        last_elapsed_ms: null,
        status: 'unknown',
        last_error: null,
        server_version: '8.0.36',
        size_bytes: 4096,
        table_count: 12,
        content: JSON.stringify({ name: 'Prod', host: 'db.exemple.fr', port: 3306, database: 'shop', username: 'ro' }),
        secret_enc: 'motdepasse',
        access_content: null,
        access_secret_enc: null,
        created: 1,
        ...over
    };
}

function alert(over: Partial<DatabaseAlertRow> & { id: number }): DatabaseAlertRow {
    return {
        database_id: 1,
        workspace_id: 1,
        enabled: 1,
        combinator: 'and',
        firing: 0,
        last_check_at: null,
        last_fired_at: null,
        last_error: null,
        content: JSON.stringify({
            name: `Alerte ${over.id}`,
            conditions: [{ sql: 'SELECT COUNT(*) FROM erreurs', comparator: 'gt', threshold: 5, label: 'erreurs' }],
            message: 'Déjà {erreurs} erreurs',
            lastValues: []
        }),
        created: 1,
        ...over
    };
}

/** Un dépôt en mémoire ; le harnais chiffre à l'identité. */
function fakeRepo(rows: DatabaseRow[], alerts: DatabaseAlertRow[] = []): FakeRepo {
    const alertChecks: FakeRepo['alertChecks'] = [];
    const unused = async () => {
        throw new Error('non attendu ici');
    };
    return {
        rows,
        alerts,
        alertChecks,
        list: unused,
        listVisible: unused,
        // Une copie, comme une ligne lue en base.
        find: async (id, workspaceId) => {
            const r = rows.find((x) => x.id === id && x.workspace_id === workspaceId);
            return r ? { ...r } : null;
        },
        findVisible: async (id, workspaceId) => {
            const r = rows.find((x) => x.id === id && x.workspace_id === workspaceId);
            return r ? { ...r } : null;
        },
        findWithStats: unused,
        findVisibleWithStats: unused,
        findByName: unused,
        countInWorkspaces: async (ids: readonly number[]) => ids.length - ids.length,
        listStock: unused,
        count: unused,
        create: unused,
        update: unused,
        remove: unused,
        reorder: unused,
        recordCheck: async (id, input) => {
            const target = rows.find((x) => x.id === id);
            if (!target) return;
            target.last_check_at = input.at;
            target.last_elapsed_ms = input.elapsedMs;
            target.status = input.status;
            target.last_error = input.error;
            target.server_version = input.serverVersion;
            target.size_bytes = input.sizeBytes;
            target.table_count = input.tableCount;
        },
        listDue: async (now, limit, pausedIds) =>
            rows
                .filter(
                    (r) =>
                        r.monitor_enabled === 1 &&
                        !pausedIds.includes(r.id) &&
                        (r.last_check_at === null || r.last_check_at + r.interval_seconds <= now)
                )
                .slice(0, limit)
                .map((r) => ({ ...r })),
        listAlerts: unused,
        listEnabledAlerts: async (databaseId) =>
            alerts.filter((a) => a.database_id === databaseId && a.enabled === 1).map((a) => ({ ...a })),
        findAlert: unused,
        createAlert: unused,
        updateAlert: unused,
        removeAlert: unused,
        recordAlertCheck: async (alertId, input) => {
            alertChecks.push({ alertId, firing: input.firing, firedAt: input.firedAt, error: input.error });
            const target = alerts.find((a) => a.id === alertId);
            if (!target) return;
            target.last_check_at = input.at;
            target.firing = input.firing ? 1 : 0;
            target.last_error = input.error;
            target.content = input.content;
            if (input.firedAt !== null) target.last_fired_at = input.firedAt;
        }
    };
}

/** Ce que la base factice répond : un inventaire, et une valeur (ou une panne) par requête. */
interface Answers {
    inventory?: Inventory;
    query?: (sql: string) => DatabaseRows;
}

function fakeSession(answers: Answers): Session & { closed: number } {
    const unused = async () => {
        throw new Error('non attendu ici');
    };
    const session = {
        closed: 0,
        serverVersion: async () => answers.inventory?.serverVersion ?? '8.0.36',
        inventory: async () => answers.inventory ?? { serverVersion: '8.0.36', sizeBytes: 8192, tableCount: 14 },
        tables: unused,
        structure: unused,
        tableRows: unused,
        query: async (sql: string) => {
            if (!answers.query) throw new Error('non attendu ici');
            return answers.query(sql);
        },
        execute: unused,
        insertRow: unused,
        updateRow: unused,
        deleteRows: unused,
        close: async () => {
            session.closed += 1;
        }
    };
    return session;
}

const number = (n: number): DatabaseRows => ({ columns: ['n'], rows: [[String(n)]], total: null, elapsedMs: 0 });

/** Le service sur le harnais, avec une base pilotée par le test ; `paused`, les bases que l'offre tient en pause. */
function monitorWith(repo: FakeRepo, paused: string[] = []) {
    const deps = createTestServiceDeps({ repo, pausedItems: { connections: paused } });
    let next: (() => Session) | null = null;
    let opened = 0;
    const monitor = new DatabaseMonitor(deps, {
        openSession: async () => {
            opened += 1;
            if (!next) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
            return next();
        }
    });
    return {
        deps,
        monitor,
        opened: () => opened,
        /** Ce que la prochaine session répond ; `null` = la base est injoignable. */
        answer(answers: Answers | null) {
            next = answers === null ? null : () => fakeSession(answers);
        }
    };
}

describe('la boucle', () => {
    it('pose un ticker à trente secondes, et relève les bases dues à chaque tour', async () => {
        const repo = fakeRepo([row({ id: 1 }), row({ id: 2, monitor_enabled: 0 })]);
        const { deps, answer } = monitorWith(repo);
        assert.deepEqual(
            deps.recorded.tickers.map((t) => t.intervalMs),
            [30_000]
        );
        answer({});
        await deps.recorded.tickers[0].tick();
        // Seule la base surveillée entre dans la boucle.
        assert.equal(repo.rows[0].status, 'up');
        assert.equal(repo.rows[1].status, 'unknown');
    });
});

describe('un relevé', () => {
    it('enregistre un succès, inventaire compris, et diffuse à l’espace', async () => {
        const repo = fakeRepo([row()]);
        const { deps, monitor, answer } = monitorWith(repo);
        answer({ inventory: { serverVersion: '11.4.2-MariaDB', sizeBytes: 65536, tableCount: 3 } });

        const probe = await monitor.checkNow(1, 1);
        assert.equal(probe.ok, true);
        assert.equal(probe.serverVersion, '11.4.2-MariaDB');
        assert.equal(repo.rows[0].status, 'up');
        assert.equal(repo.rows[0].server_version, '11.4.2-MariaDB');
        assert.equal(repo.rows[0].size_bytes, 65536);
        assert.equal(repo.rows[0].table_count, 3);
        assert.equal(repo.rows[0].last_error, null);
        assert.notEqual(repo.rows[0].last_check_at, null);
        assert.deepEqual(deps.recorded.liveChanges, [1]);
    });

    it('enregistre un échec avec sa cause chiffrée, et conserve la version et la taille connues', async () => {
        const repo = fakeRepo([row()]);
        const { deps, monitor, answer } = monitorWith(repo);
        answer(null);

        const probe = await monitor.checkNow(1, 1);
        assert.equal(probe.ok, false);
        assert.equal(probe.error, 'Connexion refusée : rien n’écoute sur cet hôte et ce port.');
        assert.equal(repo.rows[0].status, 'down');
        // Le harnais chiffre à l'identité : la phrase claire est dans la colonne.
        assert.equal(repo.rows[0].last_error, probe.error);
        assert.equal(repo.rows[0].server_version, '8.0.36');
        assert.equal(repo.rows[0].size_bytes, 4096);
        assert.equal(repo.rows[0].table_count, 12);
        assert.deepEqual(deps.recorded.liveChanges, [1]);
    });

    it('une base introuvable chez elle est une réponse, pas une erreur', async () => {
        const { monitor } = monitorWith(fakeRepo([row()]));
        const probe = await monitor.checkNow(1, 42);
        assert.deepEqual(probe, { ok: false, serverVersion: null, elapsedMs: 0, error: 'Base introuvable.' });
    });

    it('deux relevés simultanés de la même base partagent la même session', async () => {
        const repo = fakeRepo([row()]);
        const { monitor, answer, opened } = monitorWith(repo);
        answer({});
        const [a, b] = await Promise.all([monitor.checkNow(1, 1), monitor.checkNow(1, 1)]);
        assert.equal(a, b);
        assert.equal(opened(), 1);
    });
});

describe('la pause d’offre', () => {
    it('une base en pause n’entre pas dans la boucle, et un relevé demandé n’ouvre rien ni n’écrit rien', async () => {
        const repo = fakeRepo([row({ id: 1 }), row({ id: 2 })]);
        const { monitor, answer, opened, deps } = monitorWith(repo, ['2']);
        answer({});
        await deps.recorded.tickers[0].tick();
        assert.deepEqual(
            repo.rows.map((r) => [r.id, r.status, r.monitor_enabled]),
            [
                [1, 'up', 1],
                [2, 'unknown', 1]
            ]
        );
        assert.equal(opened(), 1);

        const probe = await monitor.checkNow(2, 1);
        assert.deepEqual(probe, {
            ok: false,
            serverVersion: null,
            elapsedMs: 0,
            error: 'Au-delà de l’offre : cette base est en pause.'
        });
        assert.equal(opened(), 1);
        assert.equal(repo.rows[1].last_check_at, null);
    });

    it('Projets ne l’ouvre pas, et rend la raison ; Sauvegardes l’ouvre, que borne son propre stockage', async (t) => {
        const server = createServer((socket) => socket.end());
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
        const { port } = server.address() as AddressInfo;
        setAllowPrivateForTest(true);
        t.after(async () => {
            setAllowPrivateForTest(false);
            await new Promise<void>((resolve) => server.close(() => resolve()));
        });
        const content = { name: 'Prod', host: '127.0.0.1', port, database: 'shop', username: 'ro' };
        const repo = fakeRepo([row({ id: 2, content: JSON.stringify(content) })]);
        const service = serverEntry.createService?.(
            createTestServiceDeps({ repo, pausedItems: { connections: ['2'] } })
        );
        const measure = service?.providers?.[DATABASE_MEASURE_PROVIDER] as DatabaseMeasureProvider | undefined;
        const backup = service?.providers?.[DATABASE_BACKUP_PROVIDER] as DatabaseBackupProvider | undefined;
        assert.ok(measure && backup);
        assert.deepEqual(await measure.measure(2, 1, ['SELECT 1', 'SELECT 2']), [
            { value: null, error: 'Au-delà de l’offre : cette base est en pause.' },
            { value: null, error: 'Au-delà de l’offre : cette base est en pause.' }
        ]);
        const access = await backup.openAccess(2, 1);
        assert.ok(access);
        await access.close();
    });

    it('Sauvegardes demande qui peut explorer la base : l’écriture, surcharge de l’élément comprise', async () => {
        const asked: unknown[] = [];
        const service = serverEntry.createService?.(
            createTestServiceDeps({
                repo: fakeRepo([row({ id: 2 })]),
                access: {
                    feature: (workspaceId, userId, need) => {
                        asked.push({ workspaceId, userId, need });
                        return Promise.resolve({ ok: false, reason: 'read_only' });
                    }
                }
            })
        );
        const backup = service?.providers?.[DATABASE_BACKUP_PROVIDER] as DatabaseBackupProvider | undefined;
        assert.ok(backup);
        assert.deepEqual(await backup.authorize(2, 1, 9), { ok: false, reason: 'read_only' });
        assert.deepEqual(asked, [{ workspaceId: 1, userId: 9, need: { level: 'write', itemId: '2' } }]);
    });
});

describe('les alertes', () => {
    it('notifie aux transitions seulement, dans les deux sens, sur la route de la base', async () => {
        const repo = fakeRepo([row()], [alert({ id: 10 })]);
        const { deps, monitor, answer } = monitorWith(repo);

        // Sous le seuil : rien ne part, l'état est écrit sans date de montée.
        answer({ query: () => number(2) });
        await monitor.checkNow(1, 1);
        assert.equal(repo.alerts[0].firing, 0);
        assert.equal(repo.alerts[0].last_fired_at, null);
        assert.equal(deps.recorded.notifications.length, 0);

        // Franchi : une alerte sur la route de la base, embeds compris, et
        // `last_fired_at` posé.
        answer({ query: () => number(12) });
        await monitor.checkNow(1, 1);
        assert.equal(repo.alerts[0].firing, 1);
        const firedAt = repo.alerts[0].last_fired_at;
        assert.notEqual(firedAt, null);
        assert.equal(deps.recorded.notifications.length, 1);
        assert.equal(deps.recorded.notifications[0].itemId, 1);
        assert.equal(deps.recorded.notifications[0].embeds, 1);
        assert.ok(deps.recorded.notifications[0].subject.includes('Alerte Prod'));
        assert.equal(deps.recorded.notifications[0].body, 'Déjà 12 erreurs');
        // Les dernières mesures sont rangées avec l'alerte.
        assert.deepEqual((JSON.parse(repo.alerts[0].content) as { lastValues: number[] }).lastValues, [12]);

        // Toujours franchi : même état, donc ni seconde alerte ni nouvelle date.
        answer({ query: () => number(20) });
        await monitor.checkNow(1, 1);
        assert.equal(deps.recorded.notifications.length, 1);
        assert.equal(repo.alerts[0].last_fired_at, firedAt);

        // Retour sous le seuil : annoncé, et la date de montée reste celle du
        // problème.
        answer({ query: () => number(1) });
        await monitor.checkNow(1, 1);
        assert.equal(repo.alerts[0].firing, 0);
        assert.equal(repo.alerts[0].last_fired_at, firedAt);
        assert.equal(deps.recorded.notifications.length, 2);
        assert.ok(deps.recorded.notifications[1].subject.includes('Retour à la normale'));
        assert.equal(deps.recorded.notifications[1].itemId, 1);
        assert.deepEqual(
            repo.alertChecks.map((c) => [c.firing, c.firedAt !== null]),
            [
                [false, false],
                [true, true],
                [true, false],
                [false, false]
            ]
        );
    });

    it("une alerte en échec n'arrête pas les autres, et garde son état", async () => {
        const broken = alert({
            id: 10,
            firing: 1,
            content: JSON.stringify({
                name: 'Cassée',
                conditions: [{ sql: 'SELECT nope', comparator: 'gt', threshold: 0, label: 'x' }],
                message: 'x',
                lastValues: [1]
            })
        });
        const repo = fakeRepo([row()], [broken, alert({ id: 11 })]);
        const { deps, monitor, answer } = monitorWith(repo);
        answer({
            query: (sql) => {
                if (sql === 'SELECT nope')
                    throw Object.assign(new Error("Unknown column 'nope'"), { code: 'ER_BAD_FIELD' });
                return number(12);
            }
        });
        await monitor.checkNow(1, 1);

        // La cassée : mesurée à `null`, elle ne franchit plus ; son erreur est
        // écrite, et le retour à la normale se signale.
        assert.equal(repo.alerts[0].firing, 0);
        assert.match(repo.alerts[0].last_error ?? '', /nope/);
        // La saine, évaluée malgré la cassée : elle franchit et notifie.
        assert.equal(repo.alerts[1].firing, 1);
        assert.deepEqual(
            deps.recorded.notifications.map((n) => [n.itemId, n.subject.includes('Retour') ? 'ok' : 'alerte']),
            [
                [1, 'ok'],
                [1, 'alerte']
            ]
        );
    });

    it("un relevé qui échoue n'évalue aucune alerte", async () => {
        const repo = fakeRepo([row()], [alert({ id: 10 })]);
        const { deps, monitor, answer } = monitorWith(repo);
        answer(null);
        await monitor.checkNow(1, 1);
        assert.deepEqual(repo.alertChecks, []);
        assert.equal(deps.recorded.notifications.length, 0);
    });
});

/** Le contrat offert à Projets, tel que `createService` le publie au boot. */
function itemsProviderOn(repo: FakeRepo): DatabaseItemsProvider {
    const service = serverEntry.createService?.(createTestServiceDeps({ repo }));
    assert.ok(service, 'le module crée un service');
    const provider = service.providers?.[DATABASE_ITEMS_PROVIDER] as DatabaseItemsProvider | undefined;
    assert.ok(provider, 'le service publie le contrat des éléments');
    return provider;
}

describe('DATABASE_ITEMS_PROVIDER : labelOf', () => {
    it("rend le nom déchiffré d'une base vivante, null pour un identifiant inconnu ou un autre espace", async () => {
        const provider = itemsProviderOn(fakeRepo([row()]));
        assert.equal(await provider.labelOf(1, 1), 'Prod');
        assert.equal(await provider.labelOf(42, 1), null);
        assert.equal(await provider.labelOf(1, 2), null);
    });
});

describe('l’accès par un appareil', () => {
    const deviceId = '5b0f3c1e-8d2a-4f6b-9c7e-1a2b3c4d5e6f';
    const access = JSON.stringify({
        kind: 'device',
        host: '',
        port: null,
        username: '',
        auth: 'password',
        deviceId,
        authorUserId: 7
    });
    const device = (probes: string[], online = true) =>
        testDevice({
            id: deviceId,
            name: 'Poste',
            online,
            report: { agent: { probes } } as unknown as ReturnType<typeof testDevice>['report']
        });

    it('passe par l’agent de l’appareil tant que l’auteur en garde le droit', async () => {
        const repo = fakeRepo([row({ access_content: access })]);
        const asked: { userId: number; extras: readonly string[] }[] = [];
        const deps = createTestServiceDeps({
            repo,
            devices: [device(['tunnel'])],
            access: {
                device: async (_workspaceId, userId, _deviceId, extras) => {
                    asked.push({ userId, extras });
                    return { ok: true };
                }
            },
            openTcp: async () => new PassThrough()
        });
        const target = await new DatabaseMonitor(deps).targetOf(repo.rows[0], 1);
        assert.deepEqual(asked, [{ userId: 7, extras: ['network'] }]);
        assert.ok(target.access.relay);
        await target.access.relay({ host: '127.0.0.1', port: 5432 });
        assert.deepEqual(deps.recorded.agentRequests, [{ method: 'openTcp', deviceId }]);
    });

    it('dit pourquoi elle ne passe plus : droit retiré, appareil hors ligne, agent trop ancien', async () => {
        const repo = fakeRepo([row({ access_content: access })]);
        const refused = createTestServiceDeps({
            repo,
            devices: [device(['tunnel'])],
            access: { device: async () => ({ ok: false, reason: 'not_granted' }) }
        });
        await assert.rejects(
            new DatabaseMonitor(refused).targetOf(repo.rows[0], 1),
            /ne peut plus en ouvrir le réseau \(la permission lui a été retirée\)/
        );
        const offline = createTestServiceDeps({ repo, devices: [device(['tunnel'], false)] });
        await assert.rejects(new DatabaseMonitor(offline).targetOf(repo.rows[0], 1), /« Poste » est hors ligne/);
        const old = createTestServiceDeps({ repo, devices: [device([])] });
        await assert.rejects(new DatabaseMonitor(old).targetOf(repo.rows[0], 1), /à mettre à jour/);
    });
});
