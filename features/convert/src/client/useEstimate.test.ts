import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { recalibrate } from './useEstimate';

describe('estimation recalée', () => {
    it('applique au calcul l’erreur qu’il faisait sur la même image', () => {
        // Le calcul annonçait 4 Mo là où l'essai en a pesé 1 : il annonce 2 Mo, ce sera 0,5.
        assert.equal(recalibrate(2_000_000, 1_000_000, 4_000_000), 500_000);
        assert.equal(recalibrate(4_000_000, 1_000_000, 4_000_000), 1_000_000);
    });

    it('ne dit rien sans de quoi se recaler', () => {
        assert.equal(recalibrate(null, 1_000_000, 4_000_000), null);
        assert.equal(recalibrate(2_000_000, 1_000_000, null), null);
        assert.equal(recalibrate(2_000_000, 1_000_000, 0), null);
    });
});
