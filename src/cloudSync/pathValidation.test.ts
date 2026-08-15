import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeRelPath, relPathHash, relPathProblem, safeRelPath } from './pathValidation';

/**
 * Ces règles DOIVENT rester le miroir exact de
 * `agent/src/sync/paths.rs::rel_path_problem`. Un désaccord entre les deux
 * ferait osciller un fichier accepté d'un côté et refusé de l'autre, à chaque
 * cycle et pour toujours — les cas ci-dessous sont donc dupliqués à l'identique
 * dans les tests Rust.
 */

describe('relPathProblem — noms non portables', () => {
    it('refuse ce que Windows ne sait pas écrire', () => {
        for (const bad of [
            'aux.txt',
            'CON',
            'docs/NUL.md',
            'com1',
            'LPT9.log',
            'a:b.txt',
            'quoi?.txt',
            'e<t>.txt',
            'pipe|x',
            'star*',
            'guillemet".txt',
            'fin.',
            'fin ',
            'docs/sous-dossier./x'
        ]) {
            assert.notEqual(relPathProblem(bad), null, `devrait refuser ${bad}`);
            assert.equal(safeRelPath(bad), null);
        }
    });

    it('accepte les faux amis', () => {
        // Un refus retire le fichier du cloud : un faux positif coûte cher.
        for (const ok of [
            'console.log',
            'communication.txt',
            'auxiliaire/notes.md',
            'com10',
            'nullable.rs',
            'point.dans.le.nom.txt'
        ]) {
            assert.equal(relPathProblem(ok), null, `devrait accepter ${ok}`);
        }
    });

    it('refuse les échappements et les dossiers réservés', () => {
        for (const bad of ['../etc/passwd', 'docs/../../x', 'docs//x', 'docs/./x', 'a\\b', '', '.deveye-trash/x']) {
            assert.notEqual(relPathProblem(bad), null, `devrait refuser ${JSON.stringify(bad)}`);
        }
    });

    it('refuse un composant de plus de 255 octets', () => {
        assert.equal(relPathProblem(`${'a'.repeat(255)}.txt`) !== null, true);
        assert.equal(relPathProblem('a'.repeat(255)), null);
    });
});

describe('normalisation Unicode', () => {
    it('donne le même hash de chemin en NFC et en NFD', () => {
        // macOS lit du NFD sur le disque, Linux écrit du NFC : sans cette
        // normalisation le même fichier existerait en double dans l'index.
        const nfc = 'café/note.txt';
        const nfd = 'café/note.txt';
        assert.notEqual(nfc, nfd);
        assert.equal(normalizeRelPath(nfd), nfc);
        assert.equal(relPathHash(nfd), relPathHash(nfc));
    });
});
