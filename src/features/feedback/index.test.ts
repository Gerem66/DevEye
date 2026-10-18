import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { FeedbackEntry } from '@deveye/types';

import type { FeatureContext } from '../_define';
import { feedbackListFeature, feedbackSetStatusFeature } from './index';

/** Un modérateur lit les retours sans voir d'où ils viennent : l'IP reste à l'administrateur. */

const ENTRY: FeedbackEntry = {
    id: 1,
    created: 1_700_000_000,
    kind: 'bug',
    status: 'new',
    uid: 4,
    username: 'alice',
    workspaceId: null,
    message: 'ça casse',
    ip: '203.0.113.7',
    appVersion: '1.0.0',
    snapshot: null,
    handledAt: null,
    handledBy: null,
    handledByName: null,
    anonymizedAt: null
};

function ctxAs(isAdmin: boolean): FeatureContext {
    return {
        isAdmin,
        userId: 9,
        db: {
            feedback: {
                query: async () => ({ entries: [ENTRY], total: 1, pending: 1 }),
                findById: async () => ENTRY,
                setStatus: async () => true
            }
        },
        audit() {}
    } as unknown as FeatureContext;
}

describe('les retours, vus par la modération', () => {
    it('la liste tait l’IP à un modérateur, la montre à un administrateur', async () => {
        const asModerator = await feedbackListFeature.handler(ctxAs(false), {});
        assert.equal(asModerator.entries[0]?.ip, null);
        assert.equal(asModerator.entries[0]?.message, 'ça casse');
        assert.equal(asModerator.pending, 1);
        const asAdmin = await feedbackListFeature.handler(ctxAs(true), {});
        assert.equal(asAdmin.entries[0]?.ip, '203.0.113.7');
    });

    it('la ligne rendue après un changement d’état aussi', async () => {
        const { entry } = await feedbackSetStatusFeature.handler(ctxAs(false), { id: 1, status: 'done' });
        assert.equal(entry.ip, null);
    });
});
