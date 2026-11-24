import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import Encryption from './Encryption';
import { loadRefKeys, REF_ROOT_CONTEXT, refKeysFrom } from './refKeys';

const KEY_A = 'a'.repeat(48);
const KEY_B = 'b'.repeat(48);

function memoryRepo(initial: string | null = null) {
    let sealed = initial;
    return {
        sealed: async () => sealed,
        insertSealed: async (value: string) => {
            sealed ??= value;
        },
        read: () => sealed
    };
}

describe('les condensés à clé', () => {
    const keys = refKeysFrom(Buffer.alloc(32, 7));

    it('donnent 32 caractères hexadécimaux, les mêmes pour la même valeur', () => {
        const ref = keys.ref('module:git', 'author', 4, 'alice@exemple.fr');
        assert.match(ref, /^[0-9a-f]{32}$/);
        assert.equal(keys.ref('module:git', 'author', 4, 'alice@exemple.fr'), ref);
        assert.equal(keys.ref('module:git', 'author', '4', 'alice@exemple.fr'), ref);
    });

    it('n’ont aucun rapport d’un module, d’un usage ou d’une portée à l’autre', () => {
        const refs = [
            keys.ref('module:git', 'author', 4, 'alice'),
            keys.ref('module:database', 'author', 4, 'alice'),
            keys.ref('module:git', 'name', 4, 'alice'),
            keys.ref('module:git', 'author', 5, 'alice'),
            keys.ref('core', 'author', 4, 'alice')
        ];
        assert.equal(new Set(refs).size, refs.length);
    });

    it('ne confondent pas deux découpages des mêmes caractères', () => {
        assert.notEqual(keys.ref('core', 'p', 'ab', 'c'), keys.ref('core', 'p', 'a', 'bc'));
        assert.notEqual(keys.ref('a', 'b:c', 1, 'v'), keys.ref('a:b', 'c', 1, 'v'));
        assert.notEqual(keys.ref('core', 'p', '', 'x'), keys.ref('core', 'p', 'x', ''));
    });

    it('dépendent de la racine : une autre instance ne recalcule rien', () => {
        assert.notEqual(refKeysFrom(Buffer.alloc(32, 8)).ref('core', 'p', 1, 'v'), keys.ref('core', 'p', 1, 'v'));
    });
});

describe('la racine des condensés', () => {
    it('est tirée au premier démarrage, scellée, puis relue telle quelle', async () => {
        const crypt = new Encryption(KEY_A, KEY_B);
        const repo = memoryRepo();
        const first = await loadRefKeys(repo, crypt);
        const sealed = repo.read();
        assert.ok(sealed);
        assert.equal(crypt.openFor('ref-root', sealed, REF_ROOT_CONTEXT)?.length, 32);

        const second = await loadRefKeys(repo, crypt);
        assert.equal(repo.read(), sealed);
        assert.equal(second.ref('core', 'p', 1, 'v'), first.ref('core', 'p', 1, 'v'));
    });

    it('survit à une rotation de la clé serveur : ré-emballée, elle donne les mêmes condensés', async () => {
        const before = new Encryption(KEY_A, KEY_B);
        const repo = memoryRepo();
        const first = await loadRefKeys(repo, before);

        const after = new Encryption('c'.repeat(48), 'd'.repeat(48));
        const root = before.openFor('ref-root', repo.read() as string, REF_ROOT_CONTEXT) as Buffer;
        const rotated = memoryRepo(after.sealFor('ref-root', root, REF_ROOT_CONTEXT));
        assert.equal((await loadRefKeys(rotated, after)).ref('core', 'p', 1, 'v'), first.ref('core', 'p', 1, 'v'));
    });

    it('refuse de démarrer sur une racine qu’elle ne sait pas ouvrir, plutôt que d’en tirer une autre', async () => {
        const repo = memoryRepo();
        await loadRefKeys(repo, new Encryption(KEY_A, KEY_B));
        const sealed = repo.read();
        await assert.rejects(loadRefKeys(repo, new Encryption('c'.repeat(48), 'd'.repeat(48))), /ne s’ouvre pas/);
        assert.equal(repo.read(), sealed);
    });
});
