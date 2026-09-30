import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fakeQueryable } from '../pool.fake';
import { feedbackRepo } from './feedback';

/**
 * Les signalements : le filtre de l'écran d'administration se lie en
 * paramètres, et un rapport technique que le schéma ne reconnaît plus ne fait
 * pas perdre le message qui l'accompagnait.
 */

const PAGE = { limit: 10, offset: 0 };

const ROW = {
    id: 1,
    created: '1700000000',
    kind: 'bug',
    status: 'open',
    uid: 1,
    username: 'u',
    workspace_id: null,
    message: 'ça casse',
    snapshot: null as unknown,
    ip: '::1',
    app_version: '1.0.0',
    handled_at: '1700000100',
    handled_by: 2,
    handled_by_name: 'admin'
};

const normalize = (sql: string): string => sql.replace(/\s+/g, ' ').trim();

describe('le listage des signalements', () => {
    it('lie chaque critère du filtre, et compte les nouveaux hors filtre', async () => {
        const q = fakeQueryable();
        await feedbackRepo(q).query({ kind: 'bug', status: 'new', uid: 3, search: 'oops' }, PAGE);
        const [count, pending, page] = q.queries;
        assert.match(
            normalize(count!.sql),
            /WHERE f\.kind = \? AND f\.status = \? AND f\.uid = \? AND f\.message LIKE \?$/
        );
        assert.deepEqual(count!.params, ['bug', 'new', 3, '%oops%']);
        assert.match(pending!.sql, /WHERE status = 'new'$/);
        assert.deepEqual(pending!.params, []);
        assert.deepEqual(page!.params, ['bug', 'new', 3, '%oops%', 10, 0]);
    });
});

describe('la relecture d’un signalement', () => {
    it('convertit les dates et garde les noms résolus', async () => {
        const q = fakeQueryable(() => [ROW]);
        const entry = await feedbackRepo(q).findById(1);
        assert.equal(entry?.created, 1700000000);
        assert.equal(entry?.handledAt, 1700000100);
        assert.equal(entry?.handledByName, 'admin');
        assert.equal(entry?.workspaceId, null);
    });

    it('rend null pour un rapport illisible ou hors schéma, sans perdre le message', async () => {
        for (const snapshot of ['{pas du json', '{}', '[]', 42]) {
            const q = fakeQueryable(() => [{ ...ROW, snapshot }]);
            const entry = await feedbackRepo(q).findById(1);
            assert.equal(entry?.snapshot, null, `rapport ${JSON.stringify(snapshot)}`);
            assert.equal(entry?.message, 'ça casse');
        }
    });

    it('vaut null quand la ligne n’existe pas', async () => {
        const q = fakeQueryable(() => []);
        assert.equal(await feedbackRepo(q).findById(1), null);
    });
});

describe('le traitement d’un signalement', () => {
    it('lie le statut trois fois, pour la date et l’auteur du traitement', async () => {
        const q = fakeQueryable();
        assert.equal(await feedbackRepo(q).setStatus(5, 'done', 2), true);
        assert.deepEqual(q.queries[0]!.params, ['done', 'done', 'done', 2, 5]);
    });

    it('dit quand la ligne n’existait plus', async () => {
        const q = fakeQueryable(() => ({ rowCount: 0 }));
        assert.equal(await feedbackRepo(q).setStatus(5, 'done', 2), false);
        assert.equal(await feedbackRepo(q).remove(5), false);
    });

    it('compte les envois d’un compte depuis un instant', async () => {
        const q = fakeQueryable(() => [{ total: '4' }]);
        assert.equal(await feedbackRepo(q).countSince(1, 1000), 4);
        assert.deepEqual(q.queries[0]!.params, [1, 1000]);
    });
});
