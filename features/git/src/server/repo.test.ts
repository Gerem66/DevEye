import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { SdkQueryable } from '@deveye/types/sdk/server';

import { serverEntry } from './index';
import { createRepo } from './repo';

/**
 * Le SQL de la pause d'offre, tel qu'il part vers la base : l'ordonnanceur
 * écarte les dépôts en pause dans la requête elle-même (avant le `LIMIT`), et
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

describe('git : la pause d’offre en SQL', () => {
    it('listDue écarte les dépôts en pause avant le LIMIT, et omet la clause sans pause', async () => {
        const { q, sent } = recording();
        const repo = createRepo(q);

        await repo.listDue(12, []);
        assert.doesNotMatch(sent[0].sql, /NOT IN/);
        assert.deepEqual(sent[0].params, [12]);

        await repo.listDue(12, [7, 9]);
        assert.match(sent[1].sql, /WHERE enabled = 1 AND credential_id IS NOT NULL AND id NOT IN \(\?\) ORDER BY/);
        assert.deepEqual(sent[1].params, [[7, 9], 12]);
    });

    it('le stock se liste sous le WHERE du compteur, du plus ancien au plus récent', async () => {
        const { q, sent } = recording([
            { id: 3, workspace_id: 1 },
            { id: 8, workspace_id: 4 }
        ]);
        const repo = createRepo(q);

        await repo.countReposInWorkspaces([1, 4]);
        const listed = await serverEntry.quotas!.repos.list(repo, [1, 4]);
        assert.deepEqual(listed, [
            { id: '3', workspaceId: 1 },
            { id: '8', workspaceId: 4 }
        ]);
        const where = (sql: string) => /FROM git_repos (WHERE .*?)(?: ORDER BY|$)/.exec(sql)?.[1];
        assert.equal(where(sent[1].sql), where(sent[0].sql));
        assert.match(sent[1].sql, /ORDER BY created ASC, id ASC$/);
        assert.deepEqual(sent[1].params, [[1, 4]]);

        // Aucun espace possédé : rien à lister, et `IN ()` ne part jamais.
        assert.deepEqual(await repo.listStockRepos([]), []);
        assert.equal(sent.length, 2);
    });
});
