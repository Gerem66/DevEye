import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createTestServiceDeps } from '@deveye/types/sdk/testing';

import { memoryExposureRepo } from './exposure/repo.fake';
import type { NvdClient } from './nvd';
import type { CveAffectingRow, CveRepo, CveStateKey, CveUpsert, CveWatchedRow } from './repo';
import { createService } from './service';

/**
 * Le rattrapage : un produit que la veille sait reconnaître voit tout son
 * historique ingéré, pour qu'une version ancienne trouve ses CVE anciennes.
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
        ...memoryExposureRepo(),
        entries,
        watched,
        listNews: unused,
        search: unused,
        find: unused,
        findMany: unused,
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

describe('le rattrapage des produits suivis', () => {
    it('inscrit au démarrage les produits que la veille reconnaît, puis rattrape leur historique', async () => {
        const repo = memoryRepo();
        const client = nvd([nginxCve('CVE-2024-0001', '1.25.4'), nginxCve('CVE-2020-0002', '1.19.0')]);
        const deps = createTestServiceDeps({ repo });
        // Aucun catalogue ne sort sur le réseau : endoflife.date répond en panne.
        const service = createService(deps, client, { eolFetch: async () => new Response('', { status: 503 }) });
        await service.start?.();
        // Le premier tour part au démarrage sans être attendu : il rattrape
        // quatre pages, une par produit ici.
        for (let i = 0; i < 50 && repo.watched.filter((w) => w.backfilled_at !== null).length < 4; i++) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        await service.stop?.();

        const nginx = repo.watched.find((w) => w.vendor === 'f5' && w.product === 'nginx');
        assert.ok(nginx, 'nginx est suivi');
        assert.ok(nginx.backfilled_at !== null, 'son historique est rattrapé');
        assert.equal(client.productCalls, 4, 'quatre pages au premier tour, pas une de plus');
        assert.deepEqual(repo.entries.map((e) => e.id).sort(), ['CVE-2020-0002', 'CVE-2024-0001']);
    });
});
