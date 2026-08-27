import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { nextRunAt } from './schedule';

/**
 * Le calendrier d'un travail décide de ce qui part la nuit. Deux fautes y sont
 * invisibles jusqu'au jour où l'on cherche une archive qui n'existe pas :
 *
 *  - une échéance calculée **dans le passé**, qui fait repartir le travail à
 *    chaque tour de boucle et remplit la destination d'archives inutiles ;
 *  - une échéance calculée **à l'instant même** de l'enregistrement, qui
 *    déclenche une sauvegarde fantôme dès qu'on corrige une faute de frappe
 *    dans l'intitulé.
 *
 * Ces cas figent la règle : toujours strictement dans le futur, et jamais
 * d'échéance du tout pour ce qui ne doit pas partir seul.
 */

const at = (iso: string): Date => new Date(iso);
const seconds = (d: Date): number => Math.floor(d.getTime() / 1000);

describe('échéance d’un travail de sauvegarde', () => {
    it('ne planifie rien pour un travail manuel ou désactivé', () => {
        assert.equal(nextRunAt('manual', true, 3, 0, 1), null);
        assert.equal(nextRunAt('daily', false, 3, 0, 1), null);
        // Un travail désactivé ET manuel reste sans échéance : c'est ce `null`
        // qui le sort de l'index des travaux dus, sans condition en plus.
        assert.equal(nextRunAt('manual', false, 3, 0, 1), null);
    });

    it('vise la prochaine occurrence de l’heure choisie', () => {
        const from = at('2026-03-10T01:30:00');
        const next = new Date(nextRunAt('daily', true, 3, 0, 1, from)! * 1000);
        assert.equal(next.getHours(), 3);
        assert.equal(next.getDate(), 10, 'même jour : 3 h est encore devant');
    });

    it('bascule au lendemain quand l’heure est passée', () => {
        const from = at('2026-03-10T05:00:00');
        const next = new Date(nextRunAt('daily', true, 3, 0, 1, from)! * 1000);
        assert.equal(next.getHours(), 3);
        assert.equal(next.getDate(), 11);
    });

    it('ne rend jamais l’instant présent', () => {
        // LE cas qui produit une sauvegarde fantôme : enregistrer un travail
        // exactement à son heure de passage.
        const from = at('2026-03-10T03:00:00');
        const next = nextRunAt('daily', true, 3, 0, 1, from)!;
        assert.ok(next > seconds(from), 'l’échéance doit être strictement devant');
        assert.equal(new Date(next * 1000).getDate(), 11);
    });

    it('avance d’une heure pile en horaire', () => {
        const from = at('2026-03-10T05:42:17');
        const next = new Date(nextRunAt('hourly', true, 3, 0, 1, from)! * 1000);
        assert.equal(next.getHours(), 6);
        assert.equal(next.getMinutes(), 0);
        assert.equal(next.getSeconds(), 0);
    });

    it('trouve le bon jour de la semaine', () => {
        // 2026-03-10 est un mardi ; on demande le dimanche (0).
        const next = new Date(nextRunAt('weekly', true, 3, 0, 1, at('2026-03-10T05:00:00'))! * 1000);
        assert.equal(next.getDay(), 0);
        assert.equal(next.getDate(), 15);
        assert.equal(next.getHours(), 3);
    });

    it('trouve le bon quantième, y compris en franchissant février', () => {
        const next = new Date(nextRunAt('monthly', true, 4, 0, 28, at('2026-01-29T00:00:00'))! * 1000);
        assert.equal(next.getDate(), 28);
        assert.equal(next.getMonth(), 1, 'février');
        assert.equal(next.getHours(), 4);
    });

    it('reste dans le mois courant si le quantième est encore devant', () => {
        const next = new Date(nextRunAt('monthly', true, 4, 0, 15, at('2026-03-02T09:00:00'))! * 1000);
        assert.equal(next.getDate(), 15);
        assert.equal(next.getMonth(), 2, 'mars');
    });
});
