import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    addDays,
    dayIn,
    daysBetween,
    dueDateOf,
    endOfMonth,
    isExpired,
    isOverdue,
    periodBounds,
    startOfMonth,
    todayIn
} from './calendar';

describe('addDays', () => {
    it('traverse une fin de mois', () => {
        assert.equal(addDays('2026-01-31', 1), '2026-02-01');
    });

    it('traverse une fin d’année', () => {
        assert.equal(addDays('2026-12-31', 1), '2027-01-01');
    });

    it('connaît les années bissextiles', () => {
        assert.equal(addDays('2028-02-28', 1), '2028-02-29');
        assert.equal(addDays('2026-02-28', 1), '2026-03-01');
    });

    it('recule', () => {
        assert.equal(addDays('2026-03-01', -1), '2026-02-28');
    });

    it('ne bouge pas à zéro', () => {
        assert.equal(addDays('2026-09-22', 0), '2026-09-22');
    });
});

describe('dueDateOf', () => {
    it('ajoute le délai convenu', () => {
        assert.equal(dueDateOf('2026-09-22', 30), '2026-10-22');
    });

    it('ne dérive pas au changement d’heure d’été', () => {
        // Le dernier dimanche de mars en France : en heure locale, un jour de
        // 23 heures ferait reculer le résultat d'une journée.
        assert.equal(dueDateOf('2026-03-28', 1), '2026-03-29');
        assert.equal(dueDateOf('2026-03-29', 1), '2026-03-30');
        assert.equal(dueDateOf('2026-10-24', 2), '2026-10-26');
    });

    it('accepte un paiement comptant', () => {
        assert.equal(dueDateOf('2026-09-22', 0), '2026-09-22');
    });
});

describe('bornes de mois', () => {
    it('trouve le premier et le dernier jour', () => {
        assert.equal(startOfMonth('2026-09-22'), '2026-09-01');
        assert.equal(endOfMonth('2026-09-22'), '2026-09-30');
        assert.equal(endOfMonth('2026-02-10'), '2026-02-28');
        assert.equal(endOfMonth('2028-02-10'), '2028-02-29');
        assert.equal(endOfMonth('2026-12-01'), '2026-12-31');
    });
});

describe('periodBounds', () => {
    it('cadre un mois', () => {
        assert.deepEqual(periodBounds('2026-09-22', 'month'), { from: '2026-09-01', to: '2026-09-30' });
    });

    it('cadre un trimestre, quel que soit le mois qu’on lui donne', () => {
        for (const day of ['2026-07-01', '2026-08-15', '2026-09-30']) {
            assert.deepEqual(periodBounds(day, 'quarter'), { from: '2026-07-01', to: '2026-09-30' });
        }
        assert.deepEqual(periodBounds('2026-01-05', 'quarter'), { from: '2026-01-01', to: '2026-03-31' });
        assert.deepEqual(periodBounds('2026-12-31', 'quarter'), { from: '2026-10-01', to: '2026-12-31' });
    });

    it('cadre une année', () => {
        assert.deepEqual(periodBounds('2026-09-22', 'year'), { from: '2026-01-01', to: '2026-12-31' });
    });
});

describe('daysBetween', () => {
    it('compte les jours dans le bon sens', () => {
        assert.equal(daysBetween('2026-09-01', '2026-09-22'), 21);
        assert.equal(daysBetween('2026-09-22', '2026-09-01'), -21);
        assert.equal(daysBetween('2026-09-22', '2026-09-22'), 0);
    });

    it('ne compte pas une heure de moins au changement d’heure', () => {
        assert.equal(daysBetween('2026-03-28', '2026-03-30'), 2);
        assert.equal(daysBetween('2026-10-24', '2026-10-26'), 2);
    });
});

describe('dayIn', () => {
    it('date un instant passé dans le fuseau de l’espace, pas dans celui du serveur', () => {
        // Une acceptation en ligne à une heure du matin à Paris : le papier doit
        // dire ce jour-là, et non la veille en temps universel.
        const answered = new Date('2026-09-23T01:00:00+02:00');
        assert.equal(dayIn('Europe/Paris', answered), '2026-09-23');
        assert.equal(dayIn('UTC', answered), '2026-09-22');
    });
});

describe('todayIn', () => {
    const noon = new Date('2026-09-22T23:30:00Z');

    it('donne le lendemain là où il est déjà demain', () => {
        assert.equal(todayIn('Europe/Paris', noon), '2026-09-23');
        assert.equal(todayIn('UTC', noon), '2026-09-22');
        assert.equal(todayIn('Indian/Reunion', noon), '2026-09-23');
        assert.equal(todayIn('America/New_York', noon), '2026-09-22');
    });

    it('retombe sur un jour valide quand le fuseau est refusé', () => {
        assert.match(todayIn('Mars/Olympus', noon), /^\d{4}-\d{2}-\d{2}$/);
    });
});

describe('isOverdue et isExpired', () => {
    it('laissent le jour de l’échéance tranquille', () => {
        assert.equal(isOverdue('2026-09-22', '2026-09-22'), false);
        assert.equal(isOverdue('2026-09-22', '2026-09-23'), true);
        assert.equal(isExpired('2026-09-22', '2026-09-22'), false);
        assert.equal(isExpired('2026-09-22', '2026-09-23'), true);
    });

    it('ne disent rien sans date', () => {
        assert.equal(isOverdue(null, '2026-09-23'), false);
        assert.equal(isExpired(null, '2026-09-23'), false);
    });
});
