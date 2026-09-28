import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AccountPlan } from '@deveye/types/sdk';

import type { Database } from '@/db';
import type { QuotaPauseRow } from '@/db/repos/quotaPauses';
import { createPlanPauses, type PlanPauseChange, type PlanPausesHost, type StockSource } from './planPauses';

const quiet = { warn: () => undefined, error: () => undefined };

/** La table en mémoire, avec ce que le moteur en lit. */
function memoryDb(seed: QuotaPauseRow[] = [], owners: number[] = [1]) {
    let rows = [...seed];
    const rechecks = new Map<number, number>();
    const writes = { count: 0 };
    const quotaPauses: Database['quotaPauses'] = {
        all: () => Promise.resolve([...rows]),
        ofOwnerKey: (owner, key) => Promise.resolve(rows.filter((r) => r.ownerUserId === owner && r.quotaKey === key)),
        upsert: (next) => {
            writes.count++;
            for (const row of next) {
                rows = rows.filter((r) => !(r.quotaKey === row.quotaKey && r.itemId === row.itemId));
                rows.push(row);
            }
            return Promise.resolve();
        },
        remove: (owner, key, ids) => {
            writes.count++;
            rows = rows.filter((r) => !(r.ownerUserId === owner && r.quotaKey === key && ids.includes(r.itemId)));
            return Promise.resolve();
        },
        purgeKeysOtherThan: (keys) => {
            const before = rows.length;
            rows = rows.filter((r) => keys.includes(r.quotaKey));
            return Promise.resolve(before - rows.length);
        },
        owners: () => Promise.resolve([...new Set(rows.map((r) => r.ownerUserId))]),
        setRecheck: (owner, at) => {
            rechecks.set(owner, at);
            return Promise.resolve();
        },
        takeDueRechecks: () => Promise.resolve([])
    };
    const db = {
        quotaPauses,
        workspaces: {
            listOwnedIds: () => Promise.resolve([10, 11]),
            listOwnerIds: () => Promise.resolve(owners)
        },
        transaction: <T>(fn: (tx: Database) => Promise<T>) => fn(db as unknown as Database)
    };
    return { db: db as unknown as PlanPausesHost['db'], rows: () => rows, rechecks, writes };
}

/** Une clé dont les éléments sont `ids`, du plus ancien au plus récent, tous dans l'espace 10. */
function source(fullKey: string, ids: string[], calls = { count: 0 }): StockSource {
    return {
        fullKey,
        featureId: fullKey.split('.')[0],
        overLimit: (_owner, _owned, limit) => {
            calls.count++;
            return Promise.resolve(ids.slice(limit).map((id) => ({ id, workspaceId: 10 })));
        }
    };
}

function engine(opts: {
    db: PlanPausesHost['db'];
    plan: () => Promise<AccountPlan | null>;
    sources: StockSource[];
    applied?: PlanPauseChange[][];
    limitIn?: PlanPausesHost['limitIn'];
}) {
    return createPlanPauses({
        db: opts.db,
        logger: quiet,
        planOf: opts.plan,
        limitIn: opts.limitIn ?? ((plan, fullKey) => plan?.limits[fullKey] ?? null),
        sources: () => opts.sources,
        applied: (_owner, changes) => {
            opts.applied?.push([...changes]);
            return Promise.resolve();
        }
    });
}

const plan =
    (limits: Record<string, number>, extra: Partial<AccountPlan> = {}) =>
    () =>
        Promise.resolve<AccountPlan>({ id: 'free', label: 'Gratuite', limits, priority: false, ...extra });

describe('les pauses de l’offre', () => {
    it('gardent les plus anciens et mettent les plus récents en pause', async () => {
        const mem = memoryDb();
        const applied: PlanPauseChange[][] = [];
        const e = engine({
            db: mem.db,
            plan: plan({ 'uptime.monitors': 2 }),
            sources: [source('uptime.monitors', ['1', '2', '3', '4'])],
            applied
        });
        await e.reconcile(1);
        assert.deepEqual(e.paused('uptime.monitors').sort(), ['3', '4']);
        assert.equal(e.isPaused('uptime.monitors', '1'), false);
        assert.deepEqual(e.countsOf(1), { 'uptime.monitors': 2 });
        assert.equal(e.hasPausesIn(1, 'uptime'), true);
        assert.equal(e.hasPausesIn(1, 'git'), false);
        assert.deepEqual(applied, [
            [
                {
                    key: 'uptime.monitors',
                    featureId: 'uptime',
                    paused: [
                        { id: '3', workspaceId: 10 },
                        { id: '4', workspaceId: 10 }
                    ],
                    resumed: []
                }
            ]
        ]);
    });

    it('lisent la limite par l’hôte : un compte tenu par la priorité a tout en pause, même sans limite', async () => {
        const mem = memoryDb();
        const held = { on: true };
        const e = engine({
            db: mem.db,
            plan: plan({}),
            sources: [source('uptime.monitors', ['1', '2'])],
            limitIn: (p, fullKey) => (held.on ? 0 : (p?.limits[fullKey] ?? null))
        });
        await e.reconcile(1);
        assert.deepEqual(e.paused('uptime.monitors').sort(), ['1', '2']);
        held.on = false;
        await e.reconcile(1);
        assert.deepEqual(e.paused('uptime.monitors'), []);
    });

    it('reprennent tout quand la limite disparaît, sans même lister', async () => {
        const mem = memoryDb([{ quotaKey: 'uptime.monitors', itemId: '3', ownerUserId: 1, workspaceId: 10 }]);
        const calls = { count: 0 };
        const applied: PlanPauseChange[][] = [];
        const e = engine({
            db: mem.db,
            plan: plan({}),
            sources: [source('uptime.monitors', ['1', '2', '3'], calls)],
            applied
        });
        await e.start();
        await e.stop();
        await e.reconcile(1);
        assert.equal(calls.count, 0);
        assert.deepEqual(e.paused('uptime.monitors'), []);
        assert.deepEqual(mem.rows(), []);
        assert.deepEqual(applied.at(-1)?.[0].resumed, [{ id: '3', workspaceId: 10 }]);
    });

    it('reprennent tout sans fournisseur d’offre : une installation auto-hébergée', async () => {
        const mem = memoryDb([{ quotaKey: 'uptime.monitors', itemId: '3', ownerUserId: 1, workspaceId: 10 }]);
        const e = engine({
            db: mem.db,
            plan: () => Promise.resolve(null),
            sources: [source('uptime.monitors', ['1', '2', '3'])]
        });
        await e.start();
        await e.stop();
        await e.reconcile(1);
        assert.deepEqual(mem.rows(), []);
    });

    it('ne bougent pas quand le fournisseur d’offre tombe', async () => {
        const seed = [{ quotaKey: 'uptime.monitors', itemId: '3', ownerUserId: 1, workspaceId: 10 }];
        const mem = memoryDb(seed);
        const e = engine({
            db: mem.db,
            plan: () => Promise.reject(new Error('facturation injoignable')),
            sources: [source('uptime.monitors', ['1', '2', '3'])]
        });
        await e.start();
        await e.stop();
        await e.reconcile(1);
        assert.deepEqual(mem.rows(), seed);
        assert.equal(e.isPaused('uptime.monitors', '3'), true);
    });

    it('laissent intacte la seule clé dont la liste échoue', async () => {
        const seed = [{ quotaKey: 'git.repos', itemId: '9', ownerUserId: 1, workspaceId: 10 }];
        const mem = memoryDb(seed);
        const broken: StockSource = {
            fullKey: 'git.repos',
            featureId: 'git',
            overLimit: () => Promise.reject(new Error('table absente'))
        };
        const e = engine({
            db: mem.db,
            plan: plan({ 'git.repos': 0, 'uptime.monitors': 0 }),
            sources: [broken, source('uptime.monitors', ['1'])]
        });
        await e.start();
        await e.stop();
        await e.reconcile(1);
        assert.equal(e.isPaused('git.repos', '9'), true);
        assert.equal(e.isPaused('uptime.monitors', '1'), true);
    });

    it('n’écrivent rien quand la table dit déjà ce qu’il faut', async () => {
        const mem = memoryDb([{ quotaKey: 'uptime.monitors', itemId: '3', ownerUserId: 1, workspaceId: 10 }]);
        const applied: PlanPauseChange[][] = [];
        const e = engine({
            db: mem.db,
            plan: plan({ 'uptime.monitors': 2 }),
            sources: [source('uptime.monitors', ['1', '2', '3'])],
            applied
        });
        await e.start();
        await e.stop();
        await e.reconcile(1);
        assert.equal(mem.writes.count, 0);
        assert.deepEqual(applied, []);
    });

    it('oublient au démarrage une clé que plus rien ne tient', async () => {
        const mem = memoryDb([{ quotaKey: 'x-gone.things', itemId: '1', ownerUserId: 1, workspaceId: 10 }]);
        const e = engine({ db: mem.db, plan: plan({}), sources: [source('uptime.monitors', [])] });
        await e.start();
        await e.stop();
        assert.deepEqual(mem.rows(), []);
        assert.equal(e.isPaused('x-gone.things', '1'), false);
    });

    it('relèvent l’instant où l’offre change d’elle-même', async () => {
        const mem = memoryDb();
        const e = engine({
            db: mem.db,
            plan: plan({}, { changesAt: 1_900_000_000_000 }),
            sources: []
        });
        await e.reconcile(1);
        await Promise.resolve();
        assert.equal(mem.rechecks.get(1), 1_900_000_000_000);
    });

    it('passent sur tous les propriétaires au démarrage, pas seulement ceux qui ont des pauses', async () => {
        const mem = memoryDb([], [1, 2]);
        const seen: number[] = [];
        const e = createPlanPauses({
            db: mem.db,
            logger: quiet,
            planOf: (userId) => {
                seen.push(userId);
                return Promise.resolve(null);
            },
            limitIn: () => null,
            sources: () => [],
            applied: () => Promise.resolve()
        });
        await e.start();
        await new Promise((resolve) => setTimeout(resolve, 700));
        await e.stop();
        assert.deepEqual(seen.sort(), [1, 2]);
    });
});
