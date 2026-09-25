import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { SdkQueryable } from '@deveye/types/sdk/server';

import { serverEntry } from './index';
import { createRepo } from './repo';

/**
 * Le SQL de la pause d'offre, tel qu'il part vers la base : le relevé écarte
 * les bases en pause dans la requête elle-même (avant le `LIMIT`), et le stock
 * du quota se liste sous le WHERE exact de son compteur.
 */

interface Sent {
    sql: string;
    params: unknown[];
}

function recording(rows: object[] = []) {
    const sent: Sent[] = [];
    const q: SdkQueryable = {
        query: async <T extends object>(sql: string, params?: unknown[]) => {
            sent.push({ sql: sql.replace(/\s+/g, ' ').trim(), params: params ?? [] });
            return rows as T[];
        },
        execute: async () => ({ affectedRows: 0, insertId: 0 })
    };
    return { q, sent };
}

describe('database : la pause d’offre en SQL', () => {
    it('listDue écarte les bases en pause avant le LIMIT, et omet la clause sans pause', async () => {
        const { q, sent } = recording();
        const repo = createRepo(q);

        await repo.listDue(1_000, 4, []);
        assert.doesNotMatch(sent[0].sql, /NOT IN/);
        assert.deepEqual(sent[0].params, [1_000, 4]);

        await repo.listDue(1_000, 4, [2, 8]);
        assert.match(sent[1].sql, /AND id NOT IN \(\?\) ORDER BY/);
        assert.deepEqual(sent[1].params, [1_000, [2, 8], 4]);
    });

    it('le stock se liste sous le WHERE du compteur, du plus ancien au plus récent', async () => {
        const { q, sent } = recording([
            { id: 5, workspace_id: 1 },
            { id: 6, workspace_id: 3 }
        ]);
        const repo = createRepo(q);

        await repo.countInWorkspaces([1, 3]);
        const listed = await serverEntry.quotas!.connections.list(repo, [1, 3]);
        assert.deepEqual(listed, [
            { id: '5', workspaceId: 1 },
            { id: '6', workspaceId: 3 }
        ]);
        const where = (sql: string) => /FROM database_connections (WHERE .*?)(?: ORDER BY|$)/.exec(sql)?.[1];
        assert.equal(where(sent[1].sql), where(sent[0].sql));
        assert.match(sent[1].sql, /ORDER BY created ASC, id ASC$/);
        assert.deepEqual(sent[1].params, [[1, 3]]);

        assert.deepEqual(await repo.listStock([]), []);
        assert.equal(sent.length, 2);
    });
});
