import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_FINISHING, numberBox, pageNumberLabel } from './finishing';

describe('finitions', () => {
    it('numérote selon le format, le premier numéro et la page de garde', () => {
        const on = { ...DEFAULT_FINISHING.numbers, on: true };
        assert.equal(pageNumberLabel(on, 2, 12), '3');
        assert.equal(pageNumberLabel({ ...on, format: 'n-total' }, 2, 12), '3 / 12');
        assert.equal(pageNumberLabel({ ...on, format: 'page-n-total', start: 5 }, 0, 3), 'Page 5 sur 7');
        assert.equal(pageNumberLabel({ ...on, skipFirst: true }, 0, 12), null);
        assert.equal(pageNumberLabel({ ...on, skipFirst: true, format: 'n-total' }, 1, 12), '1 / 11');
        assert.equal(pageNumberLabel(DEFAULT_FINISHING.numbers, 0, 1), null);
    });

    it('place le numéro à la marge, selon la position', () => {
        const a4 = { width: 595, height: 842 };
        assert.deepEqual(numberBox('bottom-center', a4, 20), { x: 287.5, y: 808, width: 20, height: 10 });
        assert.deepEqual(numberBox('top-right', a4, 20), { x: 551, y: 24, width: 20, height: 10 });
        assert.deepEqual(numberBox('bottom-left', a4, 20), { x: 24, y: 808, width: 20, height: 10 });
        assert.deepEqual(numberBox('top-left', a4, 20), { x: 24, y: 24, width: 20, height: 10 });
    });
});
