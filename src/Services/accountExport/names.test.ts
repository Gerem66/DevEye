import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { NameBook, safePath, safeSegment } from './names';

describe('les noms dans l’archive', () => {
    it('remplacent ce qu’un système de fichiers refuse, et ne remontent jamais', () => {
        assert.equal(safeSegment('a/b:c*?"<>|d'), 'a_b_c______d');
        assert.equal(safeSegment('  Notes.  '), 'Notes');
        assert.equal(safeSegment('..'), '_');
        assert.equal(safeSegment(''), '_');
        assert.equal(safeSegment('CON'), '_CON');
        assert.equal(safeSegment('nul.txt'), '_nul.txt');
        assert.equal(safePath('../../etc/passwd'), '_/_/etc/passwd');
        assert.equal(safePath('Espaces//Équipe/'), 'Espaces/Équipe');
        assert.ok(safeSegment(`${'x'.repeat(300)}.json`).endsWith('.json'));
        assert.ok(safeSegment('x'.repeat(300)).length <= 120);
    });

    it('dédoublonnent sans égard à la casse, extension gardée', () => {
        const book = new NameBook();
        assert.equal(book.take('Espaces/Notes'), 'Espaces/Notes');
        assert.equal(book.take('Espaces/notes'), 'Espaces/notes (2)');
        assert.equal(book.take('a/b.json'), 'a/b.json');
        assert.equal(book.take('a/b.json'), 'a/b (2).json');
        assert.equal(book.take('a/b.json'), 'a/b (3).json');
    });
});
