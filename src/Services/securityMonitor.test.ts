import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { dueSince } from './SecurityMonitor';

/**
 * Le plancher d'évaluation des règles Sentinelle.
 *
 * Ce qu'il protège : un agent qui se reconnecte en boucle réémettait rapport et
 * relevés à chaque connexion, le serveur rejouait ses règles à chaque fois, et un
 * constat de cadence horaire finissait « constaté 300 fois » en quelques heures.
 * La décision est extraite ici pour être vérifiable sans horloge ni base.
 */
describe('dueSince — plancher d’évaluation', () => {
    const FLOOR = 10 * 60 * 1000;
    const NOW = 1_700_000_000_000;

    it('autorise quand rien n’a jamais été évalué', () => {
        // Premier relevé d'un appareil : il doit être évalué, sinon la détection
        // n'existerait qu'au bout de dix minutes de vie.
        assert.equal(dueSince(undefined, NOW, FLOOR), true);
    });

    it('refuse deux évaluations rapprochées', () => {
        // Le cas de la boucle de reconnexion.
        assert.equal(dueSince(NOW, NOW, FLOOR), false);
        assert.equal(dueSince(NOW - 30_000, NOW, FLOOR), false);
        assert.equal(dueSince(NOW - (FLOOR - 1), NOW, FLOOR), false);
    });

    it('autorise de nouveau à l’échéance exacte et au-delà', () => {
        assert.equal(dueSince(NOW - FLOOR, NOW, FLOOR), true);
        assert.equal(dueSince(NOW - 3_600_000, NOW, FLOOR), true);
    });

    it('ne se laisse pas ouvrir par une date future', () => {
        // Une horloge qui recule ne doit pas débloquer l'évaluation : le sens sûr
        // est de refuser, jamais d'autoriser une inondation.
        assert.equal(dueSince(NOW + 60_000, NOW, FLOOR), false);
    });

    it('reste plus réactif que la cadence horaire des relevés', () => {
        // Le plancher n'a de sens que s'il est plus court que la cadence qu'il
        // borne : sinon il retarderait de vraies détections au lieu de filtrer
        // des doublons.
        const HOURLY = 60 * 60 * 1000;
        assert.ok(FLOOR < HOURLY);
        assert.equal(dueSince(NOW - HOURLY, NOW, FLOOR), true);
    });
});
