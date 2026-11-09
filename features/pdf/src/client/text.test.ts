import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { linesOf, type TextFragment } from './text';

const at = (str: string, x: number, y: number, width = str.length * 5, height = 10): TextFragment => ({
    str,
    transform: [height, 0, 0, height, x, y],
    width,
    height,
    hasEOL: false
});

describe('texte d’une page', () => {
    it('remet les fragments en lignes, de haut en bas et de gauche à droite', () => {
        const text = linesOf([at('monde', 60, 700), at('Bonjour', 20, 700), at('Deuxième ligne', 20, 680)]);
        assert.equal(text, 'Bonjour monde\nDeuxième ligne');
    });

    it('n’ajoute pas d’espace entre deux fragments qui se touchent', () => {
        assert.equal(linesOf([at('Bon', 20, 700, 15), at('jour', 35, 700)]), 'Bonjour');
    });

    it('tolère une ligne de base qui bouge un peu, et ignore le vide', () => {
        const text = linesOf([at('a', 20, 700), at('b', 40, 702), { ...at('', 60, 700), hasEOL: true }]);
        assert.equal(text, 'a b');
        assert.equal(linesOf([]), '');
    });
});
