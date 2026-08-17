import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { dueSince } from './SecurityMonitor';

/**
 * Le plancher d'évaluation des règles Sentinelle : il empêche une reconnexion en
 * boucle de faire rejouer des relevés horaires, ce qui gonflait les constats.
 *
 * Un opérateur inversé ici désactiverait la détection en silence, d'où ces trois
 * cas. Rien de plus : le reste de la garde est du câblage, visible à l'œil dans
 * `evaluate()`, et le vérifier demanderait de simuler base, hub et audit pour un
 * gain nul.
 */
describe('dueSince — plancher d’évaluation', () => {
    const FLOOR = 10 * 60 * 1000;
    const NOW = 1_700_000_000_000;

    it('autorise quand rien n’a jamais été évalué', () => {
        // Premier relevé d'un appareil : sans ça la détection n'existerait pas
        // avant dix minutes de vie.
        assert.equal(dueSince(undefined, NOW, FLOOR), true);
    });

    it('refuse deux évaluations rapprochées', () => {
        assert.equal(dueSince(NOW, NOW, FLOOR), false);
        assert.equal(dueSince(NOW - (FLOOR - 1), NOW, FLOOR), false);
    });

    it('autorise de nouveau à l’échéance exacte et au-delà', () => {
        assert.equal(dueSince(NOW - FLOOR, NOW, FLOOR), true);
        assert.equal(dueSince(NOW - 3_600_000, NOW, FLOOR), true);
    });
});
