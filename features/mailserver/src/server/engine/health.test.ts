import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ListenerState } from '../../contracts/domain';
import { listenersHealth } from './health';

const all = (up: Partial<Record<ListenerState['name'], boolean>>): ListenerState[] =>
    (['smtp', 'submissions', 'submission', 'imaps'] as const).map((name) => ({
        name,
        port: 1,
        up: up[name] ?? true,
        reason: ''
    }));

describe('listenersHealth', () => {
    it('sans serveur configuré, rien à surveiller', () => {
        assert.deepEqual(listenersHealth([]), { state: 'up' });
    });

    it('tous les ports ouverts', () => {
        assert.deepEqual(listenersHealth(all({})), { state: 'up' });
    });

    it('aucun port ouvert : hors service', () => {
        assert.equal(
            listenersHealth(all({ smtp: false, submissions: false, submission: false, imaps: false })).state,
            'down'
        );
    });

    it('un seul port de soumission fermé ne gêne personne', () => {
        assert.deepEqual(listenersHealth(all({ submission: false })), { state: 'up' });
    });

    it('la réception fermée : dégradé, dit en clair', () => {
        assert.deepEqual(listenersHealth(all({ smtp: false })), {
            state: 'degraded',
            reason: 'Réception des e-mails interrompue'
        });
    });

    it('les deux ports de soumission fermés : dégradé', () => {
        assert.equal(listenersHealth(all({ submission: false, submissions: false })).state, 'degraded');
    });
});
