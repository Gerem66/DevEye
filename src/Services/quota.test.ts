import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { ACCOUNT_PLAN_PROVIDER, type AccountPlan } from '@deveye/types/sdk';
import type { FeatureError } from '@deveye/types/sdk/server';

import type { Database } from '@/db';
import type { LiveHub } from '@/live/hub';
import { maintenance } from './maintenance';
import { assertPlanLimit, isHeld, limitIn, planOf, planUsage, sizeFr } from './quota';

const logger = { error: () => undefined };
const FREE: AccountPlan = { id: 'free', label: 'Gratuite', limits: { 'uptime.monitors': 5 }, priority: false };

const providers = (planFor?: () => Promise<AccountPlan>) => ({
    get: <T>(key: string) => (key === ACCOUNT_PLAN_PROVIDER && planFor ? ({ planFor } as T) : undefined)
});

describe("l'offre d'un compte", () => {
    it('est absente, donc sans limite, quand aucun module ne la fournit', async () => {
        const plan = await planOf(providers(), 1, logger);
        assert.equal(plan, null);
        assert.equal(limitIn(plan, 'uptime.monitors'), null);
    });

    it('borne les clés qu’elle nomme et laisse les autres illimitées', async () => {
        const plan = await planOf(
            providers(() => Promise.resolve(FREE)),
            1,
            logger
        );
        assert.equal(limitIn(plan, 'uptime.monitors'), 5);
        assert.equal(limitIn(plan, 'notes.items'), null);
    });

    it('ne bloque rien quand le fournisseur tombe', async () => {
        const plan = await planOf(
            providers(() => Promise.reject(new Error('facturation injoignable'))),
            1,
            logger
        );
        assert.equal(plan, null);
    });
});

describe('la comparaison à une offre', () => {
    const db = { workspaces: { listOwnedIds: async () => [1, 2] } } as never;
    const PLAN: AccountPlan = {
        id: 'free',
        label: 'Gratuite',
        limits: { 'workspace.members': 2, 'x.storage': 1024 ** 3 },
        priority: false
    };
    const bounded = providers(() => Promise.resolve(PLAN));

    it('passe à la limite, refuse au-delà, et compte sur tous les espaces du propriétaire', async () => {
        let seen: readonly number[] = [];
        const check = (count: number) => ({
            ownerUserId: 7,
            fullKey: 'workspace.members',
            label: 'membres par espace',
            countAfter: async (owned: readonly number[]) => ((seen = owned), count)
        });
        await assertPlanLimit(db, bounded, logger, check(2));
        assert.deepEqual(seen, [1, 2]);
        await assert.rejects(
            assertPlanLimit(db, bounded, logger, check(3)),
            /Gratuite atteinte : 2 membres par espace/
        );
    });

    it('ne compte rien quand la clé est illimitée ou qu’aucune offre n’existe', async () => {
        const never = {
            ownerUserId: 7,
            fullKey: 'workspace.shared',
            label: 'x',
            countAfter: () => assert.fail('compté')
        };
        await assertPlanLimit(db, bounded, logger, never);
        await assertPlanLimit(db, providers(), logger, { ...never, fullKey: 'workspace.members' });
    });

    it('écrit une limite en octets comme une taille', async () => {
        assert.equal(sizeFr(1024 ** 3), '1 Go');
        assert.equal(sizeFr(1536 * 1024 ** 2), '1,5 Go');
        await assert.rejects(
            assertPlanLimit(db, bounded, logger, {
                ownerUserId: 7,
                fullKey: 'x.storage',
                label: 'de stockage',
                unit: 'bytes',
                countAfter: async () => 2 * 1024 ** 3
            }),
            /1 Go de stockage/
        );
    });
});

describe('où en est un compte', () => {
    const db = { workspaces: { listOwnedIds: async () => [1, 2] } } as never;
    const PLAN: AccountPlan = {
        id: 'free',
        label: 'Gratuite',
        limits: { 'x.things': 0, 'x.flow': 10 },
        priority: false
    };

    it('ne compte rien sans offre ni pour une clé illimitée', async () => {
        let counted = 0;
        const used = async () => (counted++, 3);
        assert.equal(await planUsage(db, providers(), logger, { ownerUserId: 7, fullKey: 'x.flow', used }), null);
        const bounded = providers(() => Promise.resolve(PLAN));
        assert.equal(await planUsage(db, bounded, logger, { ownerUserId: 7, fullKey: 'x.other', used }), null);
        assert.equal(counted, 0);
    });

    it('compte sur les espaces du propriétaire, et garde une limite à 0', async () => {
        let seen: readonly number[] = [];
        const bounded = providers(() => Promise.resolve(PLAN));
        const use = await planUsage(db, bounded, logger, {
            ownerUserId: 7,
            fullKey: 'x.things',
            used: async (owned) => ((seen = owned), 2)
        });
        assert.deepEqual(use, { used: 2, limit: 0 });
        assert.deepEqual(seen, [1, 2]);
    });
});

describe('la priorité aux abonnés', () => {
    const db = { workspaces: { listOwnedIds: async () => [1] } } as never;
    const site = { priority: true };
    const fakeDb = {
        users: { listAdminIds: async () => [] },
        maintenance: {
            site: async () => ({
                active: false,
                message: null,
                envNoticeDismissed: false,
                updated: 0,
                updatedBy: null,
                priority: site.priority,
                priorityUpdated: null,
                priorityBy: null
            }),
            features: async () => []
        }
    } as unknown as Database;

    before(() =>
        maintenance.init({
            db: fakeDb,
            live: { broadcast() {}, closeWhere() {} } as unknown as LiveHub,
            logger: logger as never,
            services: { installed: () => [], hasService: () => false, stop: async () => {}, start: async () => {} },
            hasPlanProvider: () => true
        })
    );
    after(() => maintenance.close());

    const PRO: AccountPlan = { id: 'pro', label: 'Pro', limits: { 'uptime.monitors': 50 }, priority: true };

    it('tient à 0 toute limite d’un compte sans priorité, même une clé illimitée', () => {
        assert.equal(isHeld(FREE), true);
        assert.equal(limitIn(FREE, 'uptime.monitors'), 0);
        assert.equal(limitIn(FREE, 'git.repos'), 0);
        assert.equal(limitIn(PRO, 'uptime.monitors'), 50);
        assert.equal(limitIn(PRO, 'git.repos'), null);
        // Sans module de facturation, personne n'est tenu.
        assert.equal(limitIn(null, 'uptime.monitors'), null);
    });

    it('refuse la création sans compter, avec le motif de la priorité', async () => {
        await assert.rejects(
            assertPlanLimit(
                db,
                providers(() => Promise.resolve(FREE)),
                logger,
                {
                    ownerUserId: 7,
                    fullKey: 'uptime.monitors',
                    label: 'services surveillés',
                    countAfter: () => assert.fail('compté')
                }
            ),
            (e: FeatureError) => e.code === 'quota_exceeded' && (e.details as { priority?: boolean }).priority === true
        );
    });
});
