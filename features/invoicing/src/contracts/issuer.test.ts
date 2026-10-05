import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isIndividualForm, legalFormLine } from './issuer';

describe('legalFormLine', () => {
    it('dit le capital d’une société', () => {
        assert.equal(legalFormLine({ legalForm: 'SASU', capital: '1 000 €' }), 'SASU au capital de 1 000 €');
    });

    it('ne dit jamais de capital pour une entreprise individuelle', () => {
        for (const legalForm of [
            'EI',
            'ei',
            'EIRL',
            'Entrepreneur individuel',
            'Entreprise individuelle',
            'Micro-entreprise',
            'auto-entrepreneur'
        ]) {
            assert.equal(legalFormLine({ legalForm, capital: '1 000 €' }), legalForm, legalForm);
        }
    });

    it('tait un capital nul ou vide', () => {
        assert.equal(legalFormLine({ legalForm: 'SARL', capital: '0' }), 'SARL');
        assert.equal(legalFormLine({ legalForm: 'SARL', capital: '0,00 €' }), 'SARL');
        assert.equal(legalFormLine({ legalForm: 'SARL', capital: ' ' }), 'SARL');
    });
});

describe('isIndividualForm', () => {
    it('ne prend pas une société pour une entreprise individuelle', () => {
        for (const form of ['SASU', 'EURL', 'SAS', 'SARL', 'SA', '']) assert.equal(isIndividualForm(form), false, form);
    });
});
