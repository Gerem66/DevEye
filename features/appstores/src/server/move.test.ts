import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FeatureError, movableCellsOf, type SdkCipher, type SdkQueryable } from '@deveye/types/sdk/server';
import { createTestContext } from '@deveye/types/sdk/testing';

import { appStoresTree } from './copy';
import { appStoresMove } from './move';
import { listingRef } from './_shared';
import { fakeRepo } from './_testing';

/**
 * Le changement d'espace d'une app. Deux invariants que rien ne signale quand
 * ils cèdent : la liste des cellules à resceller, et une app du store que
 * l'arrivée suit déjà, que la base refuserait au milieu du geste.
 */

const ciphers = {
    from: { encrypt: async (v: string) => v, tryDecrypt: async (v: string) => v } as unknown as SdkCipher,
    to: { encrypt: async (v: string) => v, tryDecrypt: async (v: string) => v } as unknown as SdkCipher
};
const { keys } = createTestContext();

/** La fiche Apple de l'app déplacée, sous le condensé de l'espace 1. */
const LISTING = {
    id: 3,
    app_id: 1,
    workspace_id: 1,
    store: 'apple',
    external_ref: listingRef(keys, 1, 'apple', '1234567890'),
    content: '{"externalId":"1234567890"}'
};

function recording(answers: { taken?: number; sourced?: number; affected?: number } = {}) {
    const writes: { sql: string; params: unknown[] }[] = [];
    const asked: unknown[][] = [];
    const q: SdkQueryable = {
        async query<T extends object>(sql: string, params: unknown[] = []): Promise<T[]> {
            if (sql.startsWith('SELECT * FROM ft_appstores_listings')) return [LISTING] as unknown as T[];
            if (sql.includes('external_ref = ?')) {
                asked.push(params);
                return [{ n: answers.taken ?? 0 }] as unknown as T[];
            }
            if (sql.includes('source_id IS NOT NULL')) return [{ n: answers.sourced ?? 0 }] as unknown as T[];
            if (sql.includes('MAX(sort_order)')) return [{ next: 4 }] as unknown as T[];
            return [];
        },
        async execute(sql: string, params: unknown[] = []) {
            writes.push({ sql: sql.replace(/\s+/g, ' '), params });
            return { affectedRows: answers.affected ?? 1, insertId: 0 };
        }
    };
    return { q, writes, asked };
}

describe('le déplacement d’une app', () => {
    it('rescelle ses fiches, leur état et ses avis', () => {
        const cells = movableCellsOf(appStoresTree).map((c) => `${c.table}.${c.column}`);
        assert.deepEqual(cells.sort(), [
            'ft_appstores_apps.content',
            'ft_appstores_listings.content',
            'ft_appstores_listings.state',
            'ft_appstores_reviews.content'
        ]);
    });

    it('bloque quand l’arrivée suit déjà la même app du store, et dit la source qui reste', async () => {
        const { q, asked } = recording({ taken: 1, sourced: 1 });
        const plan = await appStoresMove.plan({
            q,
            repo: fakeRepo(),
            itemId: '1',
            fromWorkspaceId: 1,
            toWorkspaceId: 2,
            cipher: ciphers.from,
            keys
        });
        assert.deepEqual(plan.blockers, ['Cette app est déjà suivie dans cet espace.']);
        // La question est posée sous le condensé de l'arrivée : celui du départ n'y dirait rien.
        assert.deepEqual(asked, [[2, listingRef(keys, 2, 'apple', '1234567890')]]);
        assert.equal(plan.drops.length, 1);
        assert.match(plan.drops[0], /source/);
    });

    it('recalcule le condensé de ses fiches pour l’arrivée, change leur espace et leur retire la source', async () => {
        const { q, writes } = recording();
        await appStoresMove.apply({
            q,
            repo: fakeRepo(),
            itemId: '1',
            fromWorkspaceId: 1,
            toWorkspaceId: 2,
            ciphers,
            keys
        });
        assert.deepEqual(
            writes.map((w) => [w.sql, w.params]),
            [
                [
                    'UPDATE ft_appstores_listings SET external_ref = ? WHERE id = ?',
                    [listingRef(keys, 2, 'apple', '1234567890'), 3]
                ],
                [
                    'UPDATE ft_appstores_listings SET workspace_id = ?, source_id = NULL WHERE app_id = ? AND workspace_id = ?',
                    [2, 1, 1]
                ],
                [
                    'UPDATE ft_appstores_apps SET workspace_id = ?, sort_order = ? WHERE id = ? AND workspace_id = ?',
                    [2, 4, 1, 1]
                ]
            ]
        );
        assert.ok(
            !writes.some((w) => /ft_appstores_(daily|revenue)/.test(w.sql)),
            'rien à réécrire : ils pendent à app_id'
        );
    });

    it('s’annule quand l’app n’est plus dans l’espace quitté', async () => {
        const { q } = recording({ affected: 0 });
        await assert.rejects(
            appStoresMove.apply({
                q,
                repo: fakeRepo(),
                itemId: '1',
                fromWorkspaceId: 1,
                toWorkspaceId: 2,
                ciphers,
                keys
            }),
            (e) => e instanceof FeatureError && e.code === 'not_found'
        );
    });
});
