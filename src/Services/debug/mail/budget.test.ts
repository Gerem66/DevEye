import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createBudget } from './budget';

describe('le budget d’envois', () => {
    it('glisse : au-delà de la limite, on attend que les plus vieux sortent de la fenêtre', () => {
        let now = 0;
        const budget = createBudget(2, 1000, () => now);
        assert.equal(budget.take('a'), true);
        assert.equal(budget.take('a'), true);
        assert.equal(budget.take('a'), false);
        assert.equal(budget.take('b'), true);
        now = 1001;
        assert.equal(budget.take('a'), true);
    });
});
