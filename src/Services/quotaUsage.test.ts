import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { attachPlanPauses, type PlanPauses } from './planPauses';
import { usageOf, usagesOf, type UsageSource } from './quotaUsage';

const db = { workspaces: { listOwnedIds: async (owner: number) => [owner * 10, owner * 10 + 1] } } as never;

function pausesOf(counts: Record<number, Record<string, number>>): PlanPauses {
    return { countsOf: (owner: number) => counts[owner] ?? {} } as unknown as PlanPauses;
}

describe("l'utilisation d'un compte", () => {
    it('mesure chaque source sur les espaces possédés, les pauses tirées du miroir', async () => {
        attachPlanPauses(pausesOf({ 3: { 'x.things': 2 } }));
        try {
            const seen: (readonly number[])[] = [];
            const sources: UsageSource[] = [
                { fullKey: 'x.things', measure: async (_o, owned) => (seen.push(owned), { used: 5 }) },
                { fullKey: 'x.each', measure: async () => ({ used: null }) },
                { fullKey: 'core.members', measure: async () => ({ used: 4, paused: 1 }) }
            ];
            const usage = await usageOf(db, sources, 3);
            assert.deepEqual(usage, {
                userId: 3,
                quotas: {
                    'x.things': { used: 5, paused: 2 },
                    'x.each': { used: null, paused: 0 },
                    'core.members': { used: 4, paused: 1 }
                }
            });
            assert.deepEqual(seen, [[30, 31]]);
        } finally {
            attachPlanPauses(null);
        }
    });

    it('échoue en entier, en nommant la clé, quand une source tombe', async () => {
        const sources: UsageSource[] = [
            {
                fullKey: 'x.broken',
                measure: () => Promise.reject(new Error('table absente'))
            }
        ];
        await assert.rejects(usageOf(db, sources, 1), /« x\.broken » illisible : table absente/);
    });

    it('garde l’ordre donné et ne mesure jamais plus de quatre comptes à la fois', async () => {
        let inFlight = 0;
        let peak = 0;
        const sources: UsageSource[] = [
            {
                fullKey: 'x.slow',
                measure: async (owner) => {
                    inFlight++;
                    peak = Math.max(peak, inFlight);
                    await new Promise((resolve) => setTimeout(resolve, 5 + (owner % 3)));
                    inFlight--;
                    return { used: owner };
                }
            }
        ];
        const ids = [9, 2, 7, 1, 5, 3, 8, 4, 6];
        const out = await usagesOf(db, sources, ids);
        assert.deepEqual(
            out.map((u) => u.quotas['x.slow'].used),
            ids
        );
        assert.equal(peak, 4);
        assert.deepEqual(await usagesOf(db, sources, []), []);
    });
});
