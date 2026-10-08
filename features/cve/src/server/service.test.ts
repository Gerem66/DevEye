import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CVE_LOOKUP_PROVIDER, type CveLookupProvider } from '@deveye/types/sdk';
import { createTestServiceDeps } from '@deveye/types/sdk/testing';

import type { NvdClient } from './nvd';
import type { CveAffectingRow, CveRepo, CveStateKey, CveUpsert, CveWatchedRow } from './repo';
import { createService } from './service';

/**
 * Le contrat offert aux autres modules : un produit surveillé voit son
 * historique rattrapé, puis ses CVE se lisent sans un appel au NVD.
 */

function nginxCve(id: string, endExcl: string): CveUpsert {
    return {
        id,
        published: 1_600_000_000,
        lastModified: 1_600_000_000,
        severity: 'high',
        score: 7.5,
        vector: null,
        cwe: null,
        summary: `Faille ${id}`,
        references: [],
        products: [
            {
                vendor: 'f5',
                product: 'nginx',
                version: null,
                start_incl: '1.0.0',
                start_excl: null,
                end_incl: null,
                end_excl: endExcl
            }
        ]
    };
}

function memoryRepo(): CveRepo & { entries: CveUpsert[]; watched: CveWatchedRow[] } {
    const state = new Map<CveStateKey, number>();
    const entries: CveUpsert[] = [];
    const watched: CveWatchedRow[] = [];
    const unused = async (): Promise<never> => {
        throw new Error('non attendu ici');
    };
    return {
        entries,
        watched,
        listNews: unused,
        search: unused,
        find: unused,
        listFavorites: unused,
        addFavorite: unused,
        removeFavorite: unused,
        async upsertMany(rows) {
            for (const row of rows) {
                const i = entries.findIndex((e) => e.id === row.id);
                if (i === -1) entries.push(row);
                else entries[i] = row;
            }
            return rows.length;
        },
        async purge() {
            return 0;
        },
        async getState(key) {
            return state.get(key) ?? null;
        },
        async setState(key, value) {
            state.set(key, value);
        },
        async watch(products, at) {
            let added = 0;
            for (const p of products) {
                if (watched.some((w) => w.vendor === p.vendor && w.product === p.product)) continue;
                watched.push({ ...p, requested_at: at, backfill_index: 0, backfilled_at: null });
                added++;
            }
            return added;
        },
        async listWatched() {
            return watched.map((w) => ({ ...w }));
        },
        async setBackfill(vendor, product, index, doneAt) {
            const w = watched.find((x) => x.vendor === vendor && x.product === product);
            if (!w) return;
            w.backfill_index = index;
            w.backfilled_at = doneAt;
        },
        async affecting(vendor, product) {
            return entries.flatMap((e) =>
                e.products
                    .filter((p) => p.vendor === vendor && p.product === product)
                    .map((p): CveAffectingRow => ({
                        ...p,
                        cve_id: e.id,
                        severity: e.severity,
                        score: e.score,
                        summary: e.summary,
                        published: e.published
                    }))
            );
        }
    };
}

function nvd(byProduct: CveUpsert[]): NvdClient & { productCalls: number } {
    return {
        productCalls: 0,
        async window() {
            return [];
        },
        async product() {
            this.productCalls++;
            return { entries: byProduct, next: byProduct.length, done: true };
        },
        async byId() {
            return null;
        },
        async keyword() {
            return [];
        }
    };
}

describe('CVE_LOOKUP_PROVIDER', () => {
    it('rattrape l’historique d’un produit surveillé, puis dit quelles CVE touchent une version', async () => {
        const repo = memoryRepo();
        const client = nvd([nginxCve('CVE-2024-0001', '1.25.4'), nginxCve('CVE-2020-0002', '1.19.0')]);
        const deps = createTestServiceDeps({ repo });
        const service = createService(deps, client);
        const lookup = service.providers?.[CVE_LOOKUP_PROVIDER] as CveLookupProvider;
        assert.ok(lookup, 'le service publie le contrat');

        const nginx = { vendor: 'f5', product: 'nginx', version: '1.25.3' };
        const before = await lookup.affecting([nginx]);
        assert.equal(before.status, 'stale', 'un produit jamais rattrapé ne se garantit pas');

        await lookup.watch([{ vendor: 'f5', product: 'nginx' }]);
        // `watch` lance le rattrapage sans le faire attendre à l'appelant.
        for (let i = 0; i < 50 && repo.watched[0]?.backfilled_at == null; i++) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }

        const after = await lookup.affecting([nginx]);
        assert.equal(client.productCalls, 1);
        assert.equal(after.status, 'ok', 'historique rattrapé, fil à jour : le catalogue répond pour nginx');
        assert.deepEqual(
            after.hits[0].cves.map((c) => [c.cveId, c.fixedIn]),
            [['CVE-2024-0001', '1.25.4']]
        );
        assert.ok(repo.watched[0].backfilled_at !== null);
    });
});
