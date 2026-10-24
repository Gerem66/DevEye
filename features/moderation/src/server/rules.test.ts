import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    baseNameOf,
    compileNameRules,
    coversExposure,
    nameGlobToRegex,
    parseFingerprints,
    parseNamePatterns
} from './rules';

describe('nameGlobToRegex', () => {
    it('reconnaît le nom entier, casse ignorée, jokers compris', () => {
        const torrent = nameGlobToRegex('*.torrent');
        assert.ok(torrent.test('Film.TORRENT'));
        assert.ok(!torrent.test('torrent.txt'));
        const keygen = nameGlobToRegex('keygen?.exe');
        assert.ok(keygen.test('keygen1.exe'));
        assert.ok(!keygen.test('keygen12.exe'));
        assert.ok(nameGlobToRegex('rapport (1).pdf').test('Rapport (1).PDF'));
    });

    it('ne laisse pas un motif lire comme une expression régulière', () => {
        assert.ok(!nameGlobToRegex('a.b').test('axb'));
        assert.ok(nameGlobToRegex('[x]').test('[x]'));
    });
});

describe('compileNameRules', () => {
    it('ignore un motif qui ne compile pas, sans arrêter les autres', () => {
        const compiled = compileNameRules([{ pattern: '*.exe' }, { pattern: 'ok' }]);
        assert.equal(compiled.length, 2);
        assert.ok(compiled[0].test('setup.exe'));
    });
});

describe('coversExposure', () => {
    it('une règle publique ne regarde pas le stockage privé, une règle partout regarde tout', () => {
        assert.ok(coversExposure('public', 'public'));
        assert.ok(!coversExposure('public', 'private'));
        assert.ok(coversExposure('everywhere', 'private'));
    });
});

describe('parseFingerprints', () => {
    it('lit une empreinte par ligne, en minuscules, et ignore commentaires, doublons et le reste', () => {
        const a = 'A'.repeat(64);
        const b = 'b'.repeat(64);
        const text = [
            '# commentaire',
            a,
            `"${b}","2026-10-20","exe"`,
            b,
            'pas une empreinte',
            'c'.repeat(128),
            ''
        ].join('\n');
        const { fingerprints, ignored } = parseFingerprints(text);
        assert.deepEqual(fingerprints, [a.toLowerCase(), b]);
        assert.equal(ignored, 3);
    });
});

describe('parseNamePatterns', () => {
    it('lit un motif par ligne, sans doublon ni casse, et nomme la ligne qui ne va pas', () => {
        const ok = parseNamePatterns('*.torrent\n\n# note\n*.TORRENT\nkeygen?.exe');
        assert.deepEqual(ok, { patterns: ['*.torrent', 'keygen?.exe'], ignored: 1, problem: null });
        const bad = parseNamePatterns('*.exe\n***');
        assert.equal(bad.problem?.line, 2);
    });
});

describe('baseNameOf', () => {
    it('garde le dernier segment, quel que soit le séparateur', () => {
        assert.equal(baseNameOf('Documents/2026/bilan.pdf'), 'bilan.pdf');
        assert.equal(baseNameOf('C:\\Users\\x\\film.mkv'), 'film.mkv');
        assert.equal(baseNameOf('seul.txt'), 'seul.txt');
    });
});
