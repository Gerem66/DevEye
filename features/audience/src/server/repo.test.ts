import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { SdkQueryable } from '@deveye/types/sdk/server';

import { manifest } from '../manifest';
import { serverEntry } from './index';
import { createRepo } from './repo';

/**
 * La liste que l'offre range : les sites que compte le quota, sous le filtre
 * exact de son compteur, du plus ancien au plus récent. Un ordre ou un filtre
 * faux mettrait en pause d'autres sites que les derniers créés.
 */

function recording(rows: object[] = []): { q: SdkQueryable; calls: { sql: string; params: unknown[] }[] } {
    const calls: { sql: string; params: unknown[] }[] = [];
    const q: SdkQueryable = {
        async query<T extends object>(sql: string, params: unknown[] = []): Promise<T[]> {
            calls.push({ sql, params });
            return rows as T[];
        },
        async execute(sql: string, params: unknown[] = []) {
            calls.push({ sql, params });
            return { affectedRows: 0, insertId: 0 };
        }
    };
    return { q, calls };
}

describe('la liste du stock', () => {
    it('rend les sites du plus ancien au plus récent, sous le filtre du compteur', async () => {
        const { q, calls } = recording([
            { id: 2, workspace_id: 1 },
            { id: 9, workspace_id: 3 }
        ]);
        assert.deepEqual(await serverEntry.quotas?.sites.list(createRepo(q), [1, 3]), [
            { id: '2', workspaceId: 1 },
            { id: '9', workspaceId: 3 }
        ]);
        assert.equal(
            calls[0].sql,
            'SELECT id, workspace_id FROM audience_sites WHERE workspace_id IN (?) ORDER BY created ASC, id ASC'
        );
        assert.deepEqual(calls[0].params, [[1, 3]]);

        await createRepo(q).countInWorkspaces([1, 3]);
        assert.match(calls[1].sql, /FROM audience_sites WHERE workspace_id IN \(\?\)$/);
    });

    it('ne lit rien pour un compte sans espace', async () => {
        const { q, calls } = recording();
        assert.deepEqual(await createRepo(q).listStock([]), []);
        assert.equal(calls.length, 0);
    });

    it('tient chaque quota `stock` du manifest, et lui seul', () => {
        const stock = (manifest.quotas ?? []).filter((quota) => 'stock' in quota && quota.stock).map((q) => q.key);
        assert.deepEqual(Object.keys(serverEntry.quotas ?? {}), stock);
        assert.deepEqual(stock, ['sites']);
    });
});
