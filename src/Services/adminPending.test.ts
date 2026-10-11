import assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';

import type { LiveTopic } from '@deveye/types';

import { createAdminPending, PENDING_COALESCE_MS, type AdminPendingDeps, type PendingSource } from './adminPending';

/**
 * Les badges de modération : ce que chaque compte peut traiter, et la trame
 * qui les fait relire. Un module en panne n'éteint pas les autres, un
 * modérateur ne voit que les onglets de modération des fonctionnalités qu'il
 * peut ouvrir.
 */

const reports: PendingSource = {
    featureId: 'shortlinks',
    tabs: [{ id: 'reports', moderation: true }],
    read: async () => ({ reports: 3 })
};
const queue: PendingSource = {
    featureId: 'x-audit',
    tabs: [{ id: 'queue' }],
    read: async () => ({ queue: 2 })
};
const broken: PendingSource = {
    featureId: 'x-hosting',
    tabs: [{ id: 'reports', moderation: true }],
    read: async () => {
        throw new Error('base indisponible');
    }
};

function harness(over: Partial<AdminPendingDeps> = {}) {
    const errors: { obj: object; msg: string }[] = [];
    const pushes: { userId: number; workspaceId: number; topics: readonly LiveTopic[]; by: number | null }[] = [];
    let feedbackReads = 0;
    const deps: AdminPendingDeps = {
        db: {
            users: {
                listModeratorIds: async () => [
                    { id: 1, personalWorkspaceId: 10 },
                    { id: 2, personalWorkspaceId: 20 }
                ]
            },
            feedback: {
                countPending: async () => {
                    feedbackReads += 1;
                    return 4;
                }
            }
        } as unknown as AdminPendingDeps['db'],
        live: {
            userChanged: (userId, workspaceId, topics, by) => {
                pushes.push({ userId, workspaceId, topics, by });
            }
        },
        logger: {
            error: (obj, msg) => {
                errors.push({ obj, msg });
            }
        },
        sources: [reports, queue, broken],
        feedbackEnabled: true,
        refuses: () => false,
        ...over
    };
    return { service: createAdminPending(deps), errors, pushes, feedbackReads: () => feedbackReads };
}

describe('adminPending : ce que chaque compte peut traiter', () => {
    it("l'administrateur reçoit tout ; un module en panne compte pour rien et se journalise", async () => {
        const { service, errors } = harness();
        assert.deepEqual(await service.forViewer(true), {
            feedback: 4,
            features: { shortlinks: { reports: 3 }, 'x-audit': { queue: 2 } }
        });
        assert.equal(errors.length, 1);
        assert.deepEqual((errors[0].obj as { module: string }).module, 'x-hosting');
    });

    it('le modérateur ne reçoit que les onglets de modération, et les retours', async () => {
        const { service } = harness();
        assert.deepEqual(await service.forViewer(false), { feedback: 4, features: { shortlinks: { reports: 3 } } });
    });

    it('une fonctionnalité que la maintenance lui refuse ne s’allume pas pour lui', async () => {
        const { service } = harness({ refuses: (id, isAdmin) => id === 'shortlinks' && !isAdmin });
        assert.deepEqual((await service.forViewer(false)).features, {});
        assert.deepEqual((await service.forViewer(true)).features.shortlinks, { reports: 3 });
    });

    it('retours fermés : 0, sans lire la table', async () => {
        const { service, feedbackReads } = harness({ feedbackEnabled: false });
        assert.equal((await service.forViewer(true)).feedback, 0);
        assert.equal(feedbackReads(), 0);
    });

    it('ni zéro, ni négatif, ni onglet que le manifest ne déclare pas', async () => {
        const noisy: PendingSource = {
            featureId: 'x-noisy',
            tabs: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
            read: async () => ({ a: 0, b: -2, c: 1.7, undeclared: 9 })
        };
        const { service } = harness({ sources: [noisy] });
        assert.deepEqual((await service.forViewer(true)).features, { 'x-noisy': { c: 1 } });
    });

    it('un relevé sert les lectures rapprochées, et un changement le périme', async () => {
        const { service, feedbackReads } = harness();
        await service.forViewer(true);
        await service.forViewer(false);
        assert.equal(feedbackReads(), 1);
        service.changed();
        await service.forViewer(true);
        assert.equal(feedbackReads(), 2);
        service.close();
    });
});

describe('adminPending : la trame des badges', () => {
    it('une rafale ne pousse qu’une trame `pending` à chaque compte qui modère, dans son espace personnel', async (t: TestContext) => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const { service, pushes } = harness();
        service.changed();
        service.changed();
        service.changed();
        t.mock.timers.tick(PENDING_COALESCE_MS - 1);
        assert.deepEqual(pushes, []);
        t.mock.timers.tick(1);
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(pushes, [
            { userId: 1, workspaceId: 10, topics: ['pending'], by: null },
            { userId: 2, workspaceId: 20, topics: ['pending'], by: null }
        ]);
        service.close();
    });
});
