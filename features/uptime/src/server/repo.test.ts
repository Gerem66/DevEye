import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { SdkQueryable } from '@deveye/types/sdk/server';

import { manifest } from '../manifest';
import { serverEntry } from './index';
import { createRepo } from './repo';

/**
 * Ce que l'offre lit du dépôt : la liste des dus qui écarte les services en
 * pause dans la requête (avant le `LIMIT`, sans quoi ils affameraient les
 * autres), et les listes du stock, dans l'ordre où l'offre garde les premiers.
 */

interface Call {
    sql: string;
    params: unknown[];
}

function recording(rows: object[] = []): { q: SdkQueryable; calls: Call[] } {
    const calls: Call[] = [];
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

const flat = (sql: string) => sql.replace(/\s+/g, ' ').trim();

describe('la liste des dus', () => {
    it('écarte les services en pause dans la requête, avant le LIMIT', async () => {
        const { q, calls } = recording();
        await createRepo(q).services.listDue(1_000, 40, [7, 9]);
        const sql = flat(calls[0].sql);
        assert.match(sql, /AND id NOT IN \(\?\) ORDER BY/);
        assert.ok(sql.indexOf('NOT IN') < sql.indexOf('LIMIT'));
        assert.deepEqual(calls[0].params, [1_000, [7, 9], 40]);
    });

    it('n’écrit aucune clause sans pause : `NOT IN ()` n’est pas du SQL', async () => {
        const { q, calls } = recording();
        await createRepo(q).services.listDue(1_000, 40, []);
        assert.doesNotMatch(calls[0].sql, /NOT IN/);
        assert.deepEqual(calls[0].params, [1_000, 40]);
    });
});

describe('les listes du stock', () => {
    it('rendent services et pages du plus ancien au plus récent, sous le filtre du compteur', async () => {
        // Une page porte un identifiant à part : un service déplacé ne doit jamais la rencontrer.
        for (const [table, of, prefix] of [
            ['uptime_services', (q: SdkQueryable) => createRepo(q).services, ''],
            ['ft_uptime_pages', (q: SdkQueryable) => createRepo(q).pages, 'page:']
        ] as const) {
            const { q, calls } = recording([
                { id: 3, workspace_id: 1 },
                { id: 8, workspace_id: 2 }
            ]);
            assert.deepEqual(await of(q).listStock([1, 2]), [
                { id: `${prefix}3`, workspaceId: 1 },
                { id: `${prefix}8`, workspaceId: 2 }
            ]);
            assert.equal(
                flat(calls[0].sql),
                `SELECT id, workspace_id FROM ${table} WHERE workspace_id IN (?) ORDER BY created ASC, id ASC`
            );
            assert.deepEqual(calls[0].params, [[1, 2]]);
            // Le même filtre que le compteur passé à `quota.assert` : les deux comptes s'accordent.
            await of(q).countInWorkspaces([1, 2]);
            assert.ok(flat(calls[1].sql).endsWith(`FROM ${table} WHERE workspace_id IN (?)`), calls[1].sql);
        }
    });

    it('ne lit rien pour un compte sans espace', async () => {
        const { q, calls } = recording();
        assert.deepEqual(await createRepo(q).services.listStock([]), []);
        assert.deepEqual(await createRepo(q).pages.listStock([]), []);
        assert.equal(calls.length, 0);
    });

    it('tiennent chaque quota `stock` du manifest, et lui seul', async () => {
        const stock = (manifest.quotas ?? []).filter((quota) => 'stock' in quota && quota.stock).map((q) => q.key);
        assert.deepEqual(Object.keys(serverEntry.quotas ?? {}).sort(), [...stock].sort());

        const { q, calls } = recording([{ id: 4, workspace_id: 1 }]);
        assert.deepEqual(await serverEntry.quotas?.pages.list?.(createRepo(q), [1]), [
            { id: 'page:4', workspaceId: 1 }
        ]);
        assert.match(calls[0].sql, /ft_uptime_pages/);
    });
});
