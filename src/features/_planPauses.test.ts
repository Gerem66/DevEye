import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Database } from '@/db';
import { admitPausedAgent } from '@/agent/ws';
import { coreStockSources } from './_planPauses';

const OWNER = 1;

function sources(opts: {
    shared?: number[];
    members?: { id: number; user_id: number; workspace_id: number; date: number }[];
    domains?: { id: number; workspace_id: number; host: string }[];
}) {
    const db = {
        workspaces: { listOwnedShared: () => Promise.resolve((opts.shared ?? []).map((id) => ({ id }))) },
        workspaceMembers: {
            listByWorkspaceIds: (ids: number[]) =>
                Promise.resolve((opts.members ?? []).filter((m) => ids.includes(m.workspace_id)))
        },
        featureDomains: { rowsOf: () => Promise.resolve(opts.domains ?? []) }
    } as unknown as Pick<Database, 'workspaces' | 'workspaceMembers' | 'featureDomains'>;
    return Object.fromEntries(coreStockSources(db).map((s) => [s.fullKey, s]));
}

describe('les limites de stock du cœur', () => {
    it('gardent les espaces partagés les plus anciens', async () => {
        const over = await sources({ shared: [4, 7, 9] })['workspace.shared'].overLimit(OWNER, [], 1);
        assert.deepEqual(over, [
            { id: '7', workspaceId: 7 },
            { id: '9', workspaceId: 9 }
        ]);
    });

    it('rangent les membres par espace, le propriétaire en tête et jamais en pause', async () => {
        const members = [
            { id: 1, user_id: OWNER, workspace_id: 7, date: 300 },
            { id: 2, user_id: 20, workspace_id: 7, date: 100 },
            { id: 3, user_id: 30, workspace_id: 7, date: 200 },
            { id: 4, user_id: OWNER, workspace_id: 9, date: 50 },
            { id: 5, user_id: 40, workspace_id: 9, date: 60 }
        ];
        const source = sources({ shared: [7, 9], members })['workspace.members'];
        assert.deepEqual(await source.overLimit(OWNER, [], 2), [{ id: '7:30', workspaceId: 7 }]);
        assert.deepEqual(await source.overLimit(OWNER, [], 0), [
            { id: '7:20', workspaceId: 7 },
            { id: '7:30', workspaceId: 7 },
            { id: '9:40', workspaceId: 9 }
        ]);
    });

    it('comptent un nom une fois et mettent en pause toutes ses lignes', async () => {
        const domains = [
            { id: 1, workspace_id: 4, host: 'a.fr' },
            { id: 2, workspace_id: 4, host: 'b.fr' },
            { id: 3, workspace_id: 7, host: 'a.fr' },
            { id: 4, workspace_id: 7, host: 'c.fr' }
        ];
        const over = await sources({ domains })['domains.hosts'].overLimit(OWNER, [4, 7], 1);
        assert.deepEqual(over, [
            { id: '2', workspaceId: 4 },
            { id: '4', workspaceId: 7 }
        ]);
    });
});

describe('un agent que l’offre tient en pause', () => {
    const now = 1_000_000;
    it('est refusé tant que son jeton a de la marge', () => {
        assert.equal(admitPausedAgent({ exp: now + 20 * 86_400 }, 'current', now), 'deny');
    });
    it('reçoit son jeton suivant avant d’être refusé quand la fin approche', () => {
        assert.equal(admitPausedAgent({ exp: now + 86_400 }, 'current', now), 'rotate-then-close');
        assert.equal(admitPausedAgent({ exp: now + 20 * 86_400 }, 'previous', now), 'rotate-then-close');
    });
});
