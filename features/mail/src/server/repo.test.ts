import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { SdkQueryable } from '@deveye/types/sdk/server';

import { serverEntry } from './index';
import { createRepo } from './repo';

/**
 * Le SQL de la pause d'offre, tel qu'il part vers la base : la relève de fond
 * écarte les comptes en pause dans la requête elle-même (avant le `LIMIT`), et
 * le stock du quota se liste sous le WHERE exact de son compteur.
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

describe('mail : la pause d’offre en SQL', () => {
    it('listSyncDue écarte les comptes en pause avant le LIMIT, et omet la clause sans pause', async () => {
        const { q, sent } = recording();
        const repo = createRepo(q);

        await repo.accounts.listSyncDue(1_000, 8, []);
        assert.doesNotMatch(sent[0].sql, /NOT IN/);
        assert.deepEqual(sent[0].params, [1_000, 8]);

        await repo.accounts.listSyncDue(1_000, 8, [3, 5]);
        assert.match(sent[1].sql, /AND id NOT IN \(\?\) ORDER BY/);
        assert.deepEqual(sent[1].params, [1_000, [3, 5], 8]);
    });

    it('le stock se liste sous le WHERE du compteur, du plus ancien au plus récent', async () => {
        const { q, sent } = recording([
            { id: 2, workspace_id: 1 },
            { id: 9, workspace_id: 6 }
        ]);
        const repo = createRepo(q);

        await repo.accounts.countInWorkspaces([1, 6]);
        const listed = await serverEntry.quotas!.accounts.list(repo, [1, 6]);
        assert.deepEqual(listed, [
            { id: '2', workspaceId: 1 },
            { id: '9', workspaceId: 6 }
        ]);
        const where = (sql: string) => /FROM mail_accounts (WHERE .*?)(?: ORDER BY|$)/.exec(sql)?.[1];
        assert.equal(where(sent[1].sql), where(sent[0].sql));
        assert.match(sent[1].sql, /ORDER BY created ASC, id ASC$/);
        assert.deepEqual(sent[1].params, [[1, 6]]);

        assert.deepEqual(await repo.accounts.listStock([]), []);
        assert.equal(sent.length, 2);
    });
});
