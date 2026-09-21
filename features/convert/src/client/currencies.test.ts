import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { currencyOption, flagOf, regionOf } from './currencies';

describe('devises', () => {
    it('tire le pays du code, sauf pour les devises sans pays', () => {
        assert.equal(regionOf('USD'), 'US');
        assert.equal(regionOf('EUR'), 'EU');
        assert.equal(regionOf('XOF'), null);
    });

    it('écrit un drapeau en indicateurs régionaux', () => {
        assert.equal(flagOf('FR'), '🇫🇷');
        assert.equal(flagOf('eu'), '🇪🇺');
    });

    it('se laisse trouver par son nom, son code et son pays', () => {
        const yen = currencyOption('JPY');
        assert.equal(yen.detail, 'JPY');
        assert.match(yen.label, /yen/i);
        assert.deepEqual(yen.keywords, ['Japon']);
        assert.equal(yen.prefix, '🇯🇵');
    });

    it('n’invente ni drapeau ni pays', () => {
        const cfa = currencyOption('XOF');
        assert.equal(cfa.prefix, undefined);
        assert.deepEqual(cfa.keywords, []);
    });
});
