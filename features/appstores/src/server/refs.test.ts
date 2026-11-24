import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { itemDigest } from '@deveye/types/sdk/server';
import { createTestContext } from '@deveye/types/sdk/testing';

import { appStoresTree } from './copy';
import { listingRef, reviewRef } from './_shared';

const { keys } = createTestContext();

/** Le condensé que l'arbre tire d'une ligne : ce que la reprise, la copie et le déplacement écrivent. */
function fromTree(table: string, row: Record<string, unknown>, at: { workspaceId: number; itemId: number }): string {
    const digest = appStoresTree.find((t) => t.table === table)?.digests?.[0];
    assert.ok(digest, table);
    const value = digest.of(String(row.content), row);
    assert.ok(value !== null);
    return itemDigest(keys, digest, at, value);
}

describe('les condensés des Stores', () => {
    it('rien ne relie deux espaces, deux apps ni deux stores', () => {
        assert.match(listingRef(keys, 1, 'apple', '1234567890'), /^[0-9a-f]{32}$/);
        assert.notEqual(listingRef(keys, 1, 'apple', '1234567890'), listingRef(keys, 2, 'apple', '1234567890'));
        assert.notEqual(reviewRef(keys, 1, 'apple', 'aaaa-1111'), reviewRef(keys, 2, 'apple', 'aaaa-1111'));
        assert.notEqual(reviewRef(keys, 1, 'apple', 'aaaa-1111'), reviewRef(keys, 1, 'google', 'aaaa-1111'));
        // Une fiche et un avis du même identifiant ne se confondent pas.
        assert.notEqual(listingRef(keys, 1, 'apple', '1234567890'), reviewRef(keys, 1, 'apple', '1234567890'));
    });

    it('l’arbre relit de chaque ligne la valeur que la commande et la synchronisation ont condensée', () => {
        const at = { workspaceId: 4, itemId: 9 };
        assert.equal(
            fromTree('ft_appstores_listings', { store: 'google', content: '{"externalId":"com.exemple.app"}' }, at),
            listingRef(keys, 4, 'google', 'com.exemple.app')
        );
        assert.equal(
            fromTree(
                'ft_appstores_reviews',
                { store: 'apple', content: '{"externalId":"aaaa-1111","body":"Bof"}' },
                at
            ),
            reviewRef(keys, 9, 'apple', 'aaaa-1111')
        );
    });

    it('une ligne sans identifiant ne se condense pas : la reprise la compte illisible, une copie la refuse', () => {
        const [, listings] = appStoresTree;
        assert.throws(() => listings.digests?.[0].of('{"storeName":"Météo"}', { store: 'apple' }));
        assert.throws(() => listings.digests?.[0].of('pas du json', { store: 'apple' }));
    });
});
