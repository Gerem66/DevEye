import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Database } from '@/db';
import { attachPlanPauses, type PlanPauses } from '@/Services/planPauses';
import { coreUsageSources } from './_quota';

const OWNER = 1;

function sources(opts: {
    shared?: number[];
    members?: { user_id: number; workspace_id: number }[];
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
    return Object.fromEntries(coreUsageSources(db).map((s) => [s.fullKey, s]));
}

function pausing(ids: Record<string, string[]>): void {
    attachPlanPauses({
        isPaused: (key: string, id: string) => (ids[key] ?? []).includes(id)
    } as unknown as PlanPauses);
}

describe("l'utilisation des limites du cœur", () => {
    it('compte les espaces partagés possédés', async () => {
        assert.deepEqual(await sources({ shared: [4, 7] })['workspace.shared'].measure(OWNER, []), { used: 2 });
        assert.deepEqual(await sources({})['workspace.shared'].measure(OWNER, []), { used: 0 });
    });

    it('prend l’espace le plus peuplé, propriétaire compris, et ses seules pauses', async () => {
        const members = [
            { user_id: OWNER, workspace_id: 7 },
            { user_id: 20, workspace_id: 7 },
            { user_id: OWNER, workspace_id: 9 },
            { user_id: 30, workspace_id: 9 },
            { user_id: 40, workspace_id: 9 }
        ];
        pausing({ 'workspace.members': ['7:20', '9:40'] });
        try {
            assert.deepEqual(await sources({ shared: [7, 9], members })['workspace.members'].measure(OWNER, []), {
                used: 3,
                paused: 1
            });
        } finally {
            attachPlanPauses(null);
        }
        assert.deepEqual(await sources({})['workspace.members'].measure(OWNER, []), { used: 0, paused: 0 });
    });

    it('compte un nom une fois, en pause dès qu’une de ses lignes l’est', async () => {
        const domains = [
            { id: 1, workspace_id: 4, host: 'a.fr' },
            { id: 2, workspace_id: 4, host: 'b.fr' },
            { id: 3, workspace_id: 7, host: 'a.fr' },
            { id: 4, workspace_id: 7, host: 'c.fr' }
        ];
        pausing({ 'domains.hosts': ['3', '4'] });
        try {
            assert.deepEqual(await sources({ domains })['domains.hosts'].measure(OWNER, [4, 7]), {
                used: 3,
                paused: 2
            });
        } finally {
            attachPlanPauses(null);
        }
    });
});
