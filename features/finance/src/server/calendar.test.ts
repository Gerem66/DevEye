import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { addDays, addMonths, anchorDayOf, daysInMonth, nextOccurrence, periodBounds, rangeBounds } from './_shared';

/**
 * Le seul endroit purement calculatoire, et celui dont une erreur ne se verrait
 * pas : le chiffre reste plausible.
 */

describe('addDays', () => {
    it('traverse une fin de mois', () => {
        assert.equal(addDays('2026-01-31', 1), '2026-02-01');
    });

    it('traverse une fin d’année', () => {
        assert.equal(addDays('2026-12-31', 1), '2027-01-01');
    });

    it('recule', () => {
        assert.equal(addDays('2026-03-01', -1), '2026-02-28');
    });

    it('connaît les années bissextiles', () => {
        assert.equal(addDays('2028-02-28', 1), '2028-02-29');
        assert.equal(daysInMonth(2028, 2), 29);
        assert.equal(daysInMonth(2026, 2), 28);
    });
});

describe('addMonths', () => {
    it('garde le jour quand le mois d’arrivée est assez long', () => {
        assert.equal(addMonths('2026-01-15', 1, 15), '2026-02-15');
    });

    it('borne au dernier jour du mois d’arrivée', () => {
        assert.equal(addMonths('2026-01-31', 1, 31), '2026-02-28');
    });

    it('repose l’ancre au lieu de dériver', () => {
        // Le point de tout l'exercice : après un février, l'échéance revient au
        // 31 et n'y perd pas trois jours pour toujours.
        assert.equal(addMonths('2026-02-28', 1, 31), '2026-03-31');
    });

    it('recule à travers une année', () => {
        assert.equal(addMonths('2026-01-10', -1, 10), '2025-12-10');
        assert.equal(addMonths('2026-01-10', -13, 10), '2024-12-10');
    });
});

describe('nextOccurrence', () => {
    it('hebdomadaire, avec intervalle', () => {
        assert.equal(nextOccurrence('2026-08-18', 'weekly', 1, null), '2026-08-25');
        assert.equal(nextOccurrence('2026-08-18', 'weekly', 2, null), '2026-09-01');
    });

    it('mensuelle, trimestrielle, annuelle', () => {
        assert.equal(nextOccurrence('2026-08-31', 'monthly', 1, 31), '2026-09-30');
        assert.equal(nextOccurrence('2026-08-31', 'quarterly', 1, 31), '2026-11-30');
        assert.equal(nextOccurrence('2026-08-31', 'yearly', 1, 31), '2027-08-31');
    });

    it('une série au 31 traverse une année entière sans se déplacer', () => {
        let date = '2026-01-31';
        const days = new Set<string>();
        for (let i = 0; i < 12; i++) {
            date = nextOccurrence(date, 'monthly', 1, 31);
            days.add(date.slice(8));
        }
        // Elle passe par le 28, le 30 et le 31 selon la longueur du mois, et
        // revient toujours au 31 dès que le mois le permet.
        assert.equal(date, '2027-01-31');
        assert.deepEqual([...days].sort(), ['28', '30', '31']);
    });
});

describe('anchorDayOf', () => {
    it('n’ancre pas une cadence hebdomadaire', () => {
        assert.equal(anchorDayOf('weekly', '2026-08-18'), null);
    });

    it('ancre les autres sur leur jour', () => {
        assert.equal(anchorDayOf('monthly', '2026-08-31'), 31);
        assert.equal(anchorDayOf('yearly', '2026-02-05'), 5);
    });
});

describe('periodBounds', () => {
    it('mois : du 1er au 1er du suivant, borne de fin exclue', () => {
        assert.deepEqual(periodBounds('monthly', '2026-08-18'), { start: '2026-08-01', end: '2026-09-01' });
    });

    it('trimestre : cale sur le début du trimestre civil', () => {
        assert.deepEqual(periodBounds('quarterly', '2026-08-18'), { start: '2026-07-01', end: '2026-10-01' });
        assert.deepEqual(periodBounds('quarterly', '2026-01-01'), { start: '2026-01-01', end: '2026-04-01' });
    });

    it('année : du 1er janvier au 1er janvier suivant', () => {
        assert.deepEqual(periodBounds('yearly', '2026-08-18'), { start: '2026-01-01', end: '2027-01-01' });
    });
});

describe('rangeBounds', () => {
    it('mois : les deux bornes sont incluses, la précédente a la même forme', () => {
        assert.deepEqual(rangeBounds('month', '2026-08-18'), {
            from: '2026-08-01',
            to: '2026-08-31',
            previousFrom: '2026-07-01',
            previousTo: '2026-07-31'
        });
    });

    it('mois : février d’une année bissextile', () => {
        assert.deepEqual(rangeBounds('month', '2028-02-10'), {
            from: '2028-02-01',
            to: '2028-02-29',
            previousFrom: '2028-01-01',
            previousTo: '2028-01-31'
        });
    });

    it('trimestre', () => {
        assert.deepEqual(rangeBounds('quarter', '2026-08-18'), {
            from: '2026-07-01',
            to: '2026-09-30',
            previousFrom: '2026-04-01',
            previousTo: '2026-06-30'
        });
    });

    it('année', () => {
        assert.deepEqual(rangeBounds('year', '2026-08-18'), {
            from: '2026-01-01',
            to: '2026-12-31',
            previousFrom: '2025-01-01',
            previousTo: '2025-12-31'
        });
    });
});
