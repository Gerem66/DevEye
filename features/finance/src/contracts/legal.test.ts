import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { applyBp, microRates, microThresholds, periodOf, previousPeriod } from './legal';

/** Le calendrier des déclarations et les taux datés : une erreur ici se lirait comme un chiffre plausible. */

describe('periodOf', () => {
    it('trimestre : du 1er du trimestre à sa fin, à déclarer avant la fin du mois suivant', () => {
        assert.deepEqual(periodOf('2026-08-18', 'quarterly'), {
            key: '2026-T3',
            label: '3e trimestre 2026',
            from: '2026-07-01',
            to: '2026-09-30',
            deadline: '2026-10-31'
        });
        assert.equal(periodOf('2026-02-10', 'quarterly').label, '1er trimestre 2026');
        assert.equal(periodOf('2026-02-10', 'quarterly').deadline, '2026-04-30');
    });

    it('le quatrième trimestre et décembre se déclarent en janvier de l’année suivante', () => {
        assert.equal(periodOf('2026-11-05', 'quarterly').deadline, '2027-01-31');
        assert.equal(periodOf('2026-12-31', 'monthly').deadline, '2027-01-31');
    });

    it('mois : février se déclare avant le 31 mars', () => {
        assert.deepEqual(periodOf('2026-02-14', 'monthly'), {
            key: '2026-02',
            label: 'février 2026',
            from: '2026-02-01',
            to: '2026-02-28',
            deadline: '2026-03-31'
        });
    });
});

describe('previousPeriod', () => {
    it('recule d’une période, par-dessus le changement d’année', () => {
        assert.equal(previousPeriod(periodOf('2026-01-15', 'quarterly'), 'quarterly').key, '2025-T4');
        assert.equal(previousPeriod(periodOf('2026-01-15', 'monthly'), 'monthly').key, '2025-12');
        assert.equal(previousPeriod(periodOf('2026-05-15', 'monthly'), 'monthly').key, '2026-04');
    });
});

describe('microRates', () => {
    it('prend le taux de la date : 24,6 % en 2025, 25,6 % en 2026, formation comprise', () => {
        const options = { socialOverrideBp: null, incomeTaxPrepaid: false };
        assert.equal(microRates('bnc', '2025-06-01', options).socialBp, 2_460 + 20);
        assert.equal(microRates('bnc', '2026-06-01', options).socialBp, 2_560 + 20);
        assert.equal(microRates('bic_sales', '2026-06-01', options).socialBp, 1_230 + 10);
    });

    it('remplace les cotisations par le taux choisi, jamais la formation', () => {
        const rates = microRates('bnc', '2026-06-01', { socialOverrideBp: 1_920, incomeTaxPrepaid: false });
        assert.equal(rates.socialBp, 1_920 + 20);
    });

    it('n’ajoute le versement libératoire que s’il est choisi', () => {
        assert.equal(
            microRates('bnc', '2026-06-01', { socialOverrideBp: null, incomeTaxPrepaid: true }).incomeTaxBp,
            220
        );
        assert.equal(
            microRates('bnc', '2026-06-01', { socialOverrideBp: null, incomeTaxPrepaid: false }).incomeTaxBp,
            0
        );
    });
});

describe('microThresholds', () => {
    it('suit l’année : 77 700 € en 2025, 83 600 € en 2026 pour des services', () => {
        assert.equal(microThresholds('bnc', '2025-03-01').ceiling, 7_770_000);
        assert.equal(microThresholds('bnc', '2026-03-01').ceiling, 8_360_000);
        assert.deepEqual(microThresholds('bic_services', '2026-03-01'), {
            ceiling: 8_360_000,
            vatBase: 3_750_000,
            vatMajor: 4_125_000
        });
        assert.equal(microThresholds('bic_sales', '2026-03-01').ceiling, 20_310_000);
    });
});

describe('applyBp', () => {
    it('arrondit au centime le plus proche', () => {
        assert.equal(applyBp(1_000_000, 2_580), 258_000);
        assert.equal(applyBp(333, 2_580), 86);
    });
});
