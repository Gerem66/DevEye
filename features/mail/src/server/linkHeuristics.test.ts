import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { findSuspiciousLinks } from './linkHeuristics';

/** Les deux heuristiques locales : texte qui ment sur sa cible, domaine sosie. */
describe('findSuspiciousLinks', () => {
    it('signale un texte en forme d’URL dont le domaine diffère de la cible', () => {
        assert.deepEqual(findSuspiciousLinks('<a href="https://evil.fr/x">https://banque.fr/connexion</a>'), [
            { text: 'https://banque.fr/connexion', href: 'https://evil.fr/x', reason: 'text-href-mismatch' }
        ]);
    });

    it('signale un domaine à une ou deux lettres d’une marque surveillée, jamais la marque elle-même', () => {
        assert.deepEqual(findSuspiciousLinks('<a href="https://paypa1.com/login">Payer</a>'), [
            { text: 'Payer', href: 'https://paypa1.com/login', reason: 'lookalike-domain' }
        ]);
        assert.deepEqual(findSuspiciousLinks('<a href="https://www.paypal.com/login">Payer</a>'), []);
    });

    it('ignore les liens sans texte ou sans domaine lisible', () => {
        assert.deepEqual(findSuspiciousLinks('<a href="https://exemple.fr"></a><a href="mailto:x@y.fr">x</a>'), []);
    });
});
