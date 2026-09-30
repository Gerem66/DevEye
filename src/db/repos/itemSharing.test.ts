import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fakeQueryable } from '../pool.fake';
import { extraOverridesOf, itemSharingRepo } from './itemSharing';

/**
 * Les restrictions par élément : une colonne JSON relue quoi que le pilote en
 * fasse, et une ligne qui n'exprime plus rien qui disparaît plutôt que de
 * rester avec des valeurs neutres.
 */

describe('les permissions surchargées d’une ligne', () => {
    it('valent un objet vide quand la colonne est vide, illisible ou d’une autre forme', () => {
        for (const raw of [null, '', '{pas du json', '[true]', '"x"', '42']) {
            assert.deepEqual(extraOverridesOf({ extra_overrides: raw }), {}, `colonne ${JSON.stringify(raw)}`);
        }
    });

    it('ne gardent que les booléens, en chaîne comme en objet déjà décodé', () => {
        assert.deepEqual(extraOverridesOf({ extra_overrides: '{"a":true,"b":"x","c":false,"d":1}' }), {
            a: true,
            c: false
        });
        assert.deepEqual(extraOverridesOf({ extra_overrides: { a: true, b: 'x' } as unknown as string }), { a: true });
    });
});

describe('la pose d’une restriction', () => {
    const KEY = [1, 'notes', 'n-1', 4];

    it('laisse en place le volet qu’on ne touche pas', async () => {
        const q = fakeQueryable((sql) =>
            sql.startsWith('SELECT') ? [{ access: null, extra_overrides: '{"x":true}' }] : undefined
        );
        await itemSharingRepo(q).setGrant(1, 'notes', 'n-1', 4, {});
        const write = q.queries[1]!;
        assert.match(write.sql, /^\s*INSERT INTO item_role_grants/);
        assert.deepEqual(write.params, [...KEY, null, '{"x":true}']);
    });

    it('retire la ligne quand les deux volets redeviennent vides', async () => {
        const q = fakeQueryable((sql) =>
            sql.startsWith('SELECT') ? [{ access: null, extra_overrides: '{"x":true}' }] : undefined
        );
        await itemSharingRepo(q).setGrant(1, 'notes', 'n-1', 4, { extraOverrides: {} });
        assert.equal(q.queries.length, 2);
        assert.match(q.queries[1]!.sql, /^\s*DELETE FROM item_role_grants/);
        assert.deepEqual(q.queries[1]!.params, KEY);
    });

    it('n’écrit rien de neutre quand il n’y avait rien et qu’on ne pose rien', async () => {
        const q = fakeQueryable();
        await itemSharingRepo(q).setGrant(1, 'notes', 'n-1', 4, {});
        assert.match(q.queries[1]!.sql, /^\s*DELETE/);
    });
});
