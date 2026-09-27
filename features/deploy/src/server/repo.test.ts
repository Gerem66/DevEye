import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { SdkQueryable } from '@deveye/types/sdk/server';

import { serverEntry } from './index';
import { createRepo } from './repo';

/**
 * Le SQL de la pause d'offre, tel qu'il part vers la base : le rapprochement
 * écarte les cibles en pause dans la requête elle-même (avant le `LIMIT`), et
 * le stock du quota se liste sous le WHERE exact de son compteur, cibles des
 * machines exclues.
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

describe('deploy : la pause d’offre en SQL', () => {
    it('listTargetsDue écarte les cibles en pause avant le LIMIT, chaque clause seulement non vide', async () => {
        const { q, sent } = recording();
        const repo = createRepo(q);

        await repo.listTargetsDue(24, 500, [], []);
        assert.doesNotMatch(sent[0].sql, /NOT IN/);
        assert.deepEqual(sent[0].params, [500, 24]);

        await repo.listTargetsDue(24, 500, [], [4, 6]);
        assert.match(sent[1].sql, /AND t\.id NOT IN \(\?\) \) AS x/);
        assert.doesNotMatch(sent[1].sql, /c\.id NOT IN/);
        assert.deepEqual(sent[1].params, [[4, 6], 500, 24]);

        await repo.listTargetsDue(24, 500, [10], [4]);
        assert.match(sent[2].sql, /AND c\.id NOT IN \(\?\) AND t\.id NOT IN \(\?\)/);
        assert.deepEqual(sent[2].params, [[10], [4], 500, 24]);
    });

    it('le stock se liste sous le WHERE du compteur, machines exclues, du plus ancien au plus récent', async () => {
        const { q, sent } = recording([
            { id: 3, workspace_id: 1 },
            { id: 7, workspace_id: 2 }
        ]);
        const repo = createRepo(q);

        await repo.countTargetsInWorkspaces([1, 2]);
        const listed = await serverEntry.quotas!.targets.list!(repo, [1, 2]);
        assert.deepEqual(listed, [
            { id: '3', workspaceId: 1 },
            { id: '7', workspaceId: 2 }
        ]);
        const where = (sql: string) => /FROM deploy_targets (WHERE .*?)(?: ORDER BY|$)/.exec(sql)?.[1];
        assert.equal(where(sent[1].sql), where(sent[0].sql));
        assert.match(sent[1].sql, /provider <> 'agent' ORDER BY created ASC, id ASC$/);
        assert.deepEqual(sent[1].params, [[1, 2]]);

        assert.deepEqual(await repo.listStockTargets([]), []);
        assert.equal(sent.length, 2);
    });
});
