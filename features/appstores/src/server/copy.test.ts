import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    exportItemTree,
    FeatureError,
    itemTreeProblem,
    type ItemTreeRows,
    type SdkCipher,
    type SdkQueryable,
    type SdkQuota
} from '@deveye/types/sdk/server';

import { appStoresCopy, appStoresTree } from './copy';
import { externalRef } from './_shared';
import { fakeRepo } from './_testing';

/**
 * La copie d'une app vers un autre espace. Ce qu'elle ne doit jamais emporter
 * ne lève nulle part si on l'oublie : les revenus (la copie passe par le
 * navigateur de quelqu'un qui n'a peut-être pas le droit Revenus), la source
 * de l'espace quitté, l'état de synchronisation.
 */

const identity: SdkCipher = {
    encrypt: async (v) => v,
    decrypt: async (v) => v,
    tryDecrypt: async (v) => v
};

/** Une base réduite à ce que le moteur de copie lui demande. */
function tables(data: Record<string, Record<string, unknown>[]>): SdkQueryable {
    return {
        async query<T extends object>(sql: string): Promise<T[]> {
            const columns = /^SHOW COLUMNS FROM (\w+)/.exec(sql);
            if (columns) {
                const [first] = data[columns[1]] ?? [];
                return Object.keys(first ?? {}).map((Field) => ({ Field, Extra: '' })) as unknown as T[];
            }
            const select = /^SELECT \* FROM (\w+)/.exec(sql);
            if (select) return (data[select[1]] ?? []) as T[];
            throw new Error(`requête inattendue : ${sql}`);
        },
        async execute() {
            throw new Error('aucune écriture attendue');
        }
    };
}

function quota(): SdkQuota & { asserted: number[] } {
    const asserted: number[] = [];
    return {
        asserted,
        isPaused: () => false,
        paused: () => [],
        limit: async () => null,
        usage: async () => null,
        assertActive: async () => undefined,
        paid: async () => true,
        async assert(_key, countAfter) {
            asserted.push(await countAfter([1]));
        }
    };
}

describe('l’arbre d’une app', () => {
    it('ne porte ni les chiffres du jour ni les revenus, et ne copie pas les avis', () => {
        assert.equal(itemTreeProblem(appStoresTree), null);
        assert.deepEqual(
            appStoresTree.map((t) => t.table),
            ['ft_appstores_apps', 'ft_appstores_listings', 'ft_appstores_reviews']
        );
        assert.equal(appStoresTree.find((t) => t.table === 'ft_appstores_reviews')?.cache, true);
        const listings = appStoresTree.find((t) => t.table === 'ft_appstores_listings');
        for (const column of ['source_id', 'state', 'synced_day', 'history_from', 'last_sync_at', 'sync_error']) {
            assert.ok(listings?.omit?.includes(column), `${column} ne voyage pas`);
        }
    });

    it('s’exporte sans revenus, sans source et sans état', async () => {
        const q = tables({
            ft_appstores_apps: [
                { id: 1, workspace_id: 1, content: '{"name":"Météo","ratingCountry":"FR"}', sort_order: 0, created: 1 }
            ],
            ft_appstores_listings: [
                {
                    id: 3,
                    app_id: 1,
                    workspace_id: 1,
                    store: 'apple',
                    source_id: 10,
                    external_ref: externalRef('apple', '1234567890'),
                    content: '{"externalId":"1234567890"}',
                    state: '{"rating":4.5}',
                    history_from: 1,
                    synced_day: 2,
                    metrics_synced_at: 3,
                    reviews_synced_at: 3,
                    rating_synced_at: 3,
                    last_sync_at: 3,
                    sync_error: null,
                    created: 1
                }
            ],
            ft_appstores_revenue: [{ app_id: 1, store: 'apple', day: 1, currency: 'EUR', amount: 99, units: 1 }],
            ft_appstores_daily: [{ app_id: 1, store: 'apple', day: 1, downloads: 5 }]
        });
        const rows = await exportItemTree(q, appStoresTree, '1', identity);
        assert.deepEqual(Object.keys(rows).sort(), ['ft_appstores_apps', 'ft_appstores_listings']);
        const [listing] = rows.ft_appstores_listings;
        assert.equal(listing.source_id, undefined);
        assert.equal(listing.state, undefined);
        assert.equal(listing.synced_day, undefined);
        assert.ok(!JSON.stringify(rows).includes('EUR'));
    });
});

describe('l’arrivée d’une copie', () => {
    function bundle(listings: Record<string, unknown>[]): ItemTreeRows {
        return {
            ft_appstores_apps: [{ id: 1, content: JSON.stringify({ name: '  Météo  ', ratingCountry: 'zz' }) }],
            ft_appstores_listings: listings
        };
    }

    const taken = (n: number): SdkQueryable => ({
        query: async <T extends object>() => [{ n }] as unknown as T[],
        execute: async () => ({ affectedRows: 0, insertId: 0 })
    });

    it('compte sur l’offre de l’arrivée, et recalcule le condensé de chaque fiche', async () => {
        const rows = bundle([
            {
                id: 3,
                app_id: 1,
                store: 'apple',
                external_ref: 'forgé',
                content: '{"externalId":"1234567890","sku":"s"}'
            }
        ]);
        const q = quota();
        await appStoresCopy.admit?.({ q: taken(0), repo: fakeRepo(), quota: q, rows, toWorkspaceId: 2 });
        assert.deepEqual(q.asserted, [1], 'le compte des apps de l’arrivée, plus celle-ci');
        assert.equal(rows.ft_appstores_listings[0].external_ref, externalRef('apple', '1234567890'));
        assert.deepEqual(JSON.parse(String(rows.ft_appstores_apps[0].content)), { name: 'Météo', ratingCountry: 'FR' });
    });

    it('refuse une app du store que l’arrivée suit déjà', async () => {
        const rows = bundle([{ id: 3, app_id: 1, store: 'google', content: '{"externalId":"com.exemple.app"}' }]);
        await assert.rejects(
            appStoresCopy.admit!({ q: taken(1), repo: fakeRepo(), quota: quota(), rows, toWorkspaceId: 2 }),
            (e) => e instanceof FeatureError && e.code === 'conflict'
        );
    });

    it('refuse deux fiches pour un même store, ou un identifiant invalide', async () => {
        const twice = bundle([
            { id: 3, store: 'apple', content: '{"externalId":"1"}' },
            { id: 4, store: 'apple', content: '{"externalId":"2"}' }
        ]);
        const invalid = bundle([{ id: 3, store: 'apple', content: '{"externalId":"com.exemple"}' }]);
        for (const rows of [twice, invalid]) {
            await assert.rejects(
                appStoresCopy.admit!({ q: taken(0), repo: fakeRepo(), quota: quota(), rows, toWorkspaceId: 2 }),
                (e) => e instanceof FeatureError && e.code === 'validation'
            );
        }
    });

    it('dit ce qui reste derrière : la source, et les chiffres à relire', async () => {
        const plan = await appStoresCopy.plan!({ q: taken(1), repo: fakeRepo(), itemId: '1', workspaceId: 1 });
        assert.equal(plan.blockers.length, 0);
        assert.equal(plan.drops.length, 2);
        assert.match(plan.drops[0], /source/);
        assert.match(plan.drops[1], /revenus/);
    });
});
