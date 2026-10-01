import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { recallHistoryEntry, rememberHistory } from './historyCache';
import type { RemoteDeployment } from './providers/types';

function entry(externalId: string): RemoteDeployment {
    return {
        externalId,
        status: 'success',
        title: externalId,
        description: '',
        startedAt: 1,
        finishedAt: 2,
        logRef: `/logs/${externalId}`,
        url: null,
        details: []
    };
}

describe('historyCache : la référence d’un journal sans second aller-retour', () => {
    it('retrouve une entrée listée, et rien pour une autre cible', () => {
        rememberHistory(1, [entry('a'), entry('b')], 1_000);
        assert.equal(recallHistoryEntry(1, 'b', 2_000)?.logRef, '/logs/b');
        assert.equal(recallHistoryEntry(1, 'c', 2_000), null);
        assert.equal(recallHistoryEntry(2, 'a', 2_000), null);
    });

    it('oublie un historique vieux de plus de cinq minutes', () => {
        rememberHistory(3, [entry('a')], 1_000);
        assert.ok(recallHistoryEntry(3, 'a', 1_000 + 5 * 60_000));
        assert.equal(recallHistoryEntry(3, 'a', 1_000 + 5 * 60_000 + 1), null);
    });

    it('ne retient qu’un nombre borné de cibles, les plus récentes', () => {
        for (let id = 1_000; id < 1_250; id++) rememberHistory(id, [entry('x')], 1_000);
        assert.equal(recallHistoryEntry(1_000, 'x', 1_000), null);
        assert.ok(recallHistoryEntry(1_249, 'x', 1_000));
    });
});
