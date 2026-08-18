import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { indexFingerprint, type FingerprintEntry } from './fingerprint';

/**
 * Fixture PARTAGÉE avec `agent/src/sync/fingerprint.rs`. Les deux affirment la
 * même chaîne hexadécimale : c'est ce seul test qui sépare « le chemin rapide
 * fonctionne » de « le chemin rapide ne s'engage jamais, sans que personne ne
 * le remarque ». Si l'un des deux change, l'autre doit changer aussi.
 */
const FIXTURE: FingerprintEntry[] = [
    {
        relPath: 'a.txt',
        kind: 'file',
        hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        size: 12,
        mode: 0o644
    },
    {
        relPath: 'dossier/b.bin',
        kind: 'file',
        hash: '0000000000000000000000000000000000000000000000000000000000000001',
        size: 3400,
        mode: null
    },
    {
        relPath: 'vide',
        kind: 'dir',
        hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        size: 0,
        mode: 0o755
    }
];

describe('indexFingerprint', () => {
    it('rend le vecteur partagé avec l’agent Rust', () => {
        assert.equal(
            indexFingerprint(FIXTURE),
            '3.3412.a97be5e146c26a2a249ed6477fa0e48c2f62faeac044bd00201197045b185b40'
        );
    });

    it('ne bouge pas sur un simple touch (le mtime n’y est pas)', () => {
        // Le champ n'existe pas dans la ligne : deux relevés du même contenu à
        // des dates différentes donnent la même chaîne. C'est ce qui empêche la
        // baseline, réécrite au seul changement de hash, de désaccorder le
        // chemin rapide pour toujours.
        assert.equal(indexFingerprint(FIXTURE), indexFingerprint(FIXTURE.map((e) => ({ ...e }))));
    });

    it('ne dépend pas de l’ordre des entrées', () => {
        assert.equal(indexFingerprint([...FIXTURE].reverse()), indexFingerprint(FIXTURE));
    });

    it('bouge dès qu’un champ bouge, quel qu’il soit', () => {
        const base = indexFingerprint(FIXTURE);
        const variants: FingerprintEntry[][] = [
            [{ ...FIXTURE[0], relPath: 'autre.txt' }, ...FIXTURE.slice(1)],
            [{ ...FIXTURE[0], kind: 'dir' }, ...FIXTURE.slice(1)],
            [
                { ...FIXTURE[0], hash: '0000000000000000000000000000000000000000000000000000000000000002' },
                ...FIXTURE.slice(1)
            ],
            [{ ...FIXTURE[0], size: 13 }, ...FIXTURE.slice(1)],
            [{ ...FIXTURE[0], mode: null }, ...FIXTURE.slice(1)]
        ];
        for (const v of variants) assert.notEqual(indexFingerprint(v), base);
    });

    it('distingue un mode inconnu d’un mode nul', () => {
        const unknown = [{ ...FIXTURE[0], mode: null }, ...FIXTURE.slice(1)];
        const zero = [{ ...FIXTURE[0], mode: 0 }, ...FIXTURE.slice(1)];
        assert.notEqual(indexFingerprint(unknown), indexFingerprint(zero));
    });

    it('rend une empreinte stable pour un index vide', () => {
        assert.equal(indexFingerprint([]), `0.0.${'0'.repeat(64)}`);
    });
});
