import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { FeatureId, ItemAccess, LivePath } from '@deveye/types';

import type { FeatureContext } from '../_define';
import { liveHereFeature } from './here';

/** Le lieu que le hub retient, pour un appelant qui lit ces fonctionnalités. */
async function placeOf(
    path: LivePath,
    reads: FeatureId[],
    restrictions: Record<string, ItemAccess> = {}
): Promise<LivePath> {
    let kept: LivePath = ['jamais posé'];
    const ctx = {
        userId: 4,
        workspaceId: 1,
        db: { users: { findById: async () => ({ color: 'blue' }) } },
        canFeature: (feature: FeatureId) => reads.includes(feature),
        itemRestrictions: async () => new Map(Object.entries(restrictions)),
        live: {
            here: (_workspaceId: number, at: LivePath) => {
                kept = at;
                return [];
            }
        }
    } as unknown as FeatureContext;
    await liveHereFeature.handler(ctx, { path });
    return kept;
}

describe('live.here : le lieu déclaré se borne à ce que l’appelant lit', () => {
    it('garde le lieu d’une fonctionnalité qu’il lit', async () => {
        assert.deepEqual(await placeOf(['view:notes', 'l1:12'], ['notes']), ['view:notes', 'l1:12']);
        assert.deepEqual(await placeOf([], []), []);
    });

    it('renvoie à l’accueil sans la lecture de la fonctionnalité', async () => {
        assert.deepEqual(await placeOf(['view:mail', 'l1:12', 'l2:34'], ['notes']), []);
    });

    it('renvoie à la vue sur un élément fermé à son rôle', async () => {
        assert.deepEqual(await placeOf(['view:mail', 'l1:12', 'l2:34'], ['mail'], { '12': 'none' }), ['view:mail']);
        assert.deepEqual(await placeOf(['view:mail', 'l1:12'], ['mail'], { '12': 'read', '13': 'none' }), [
            'view:mail',
            'l1:12'
        ]);
    });

    it('laisse une vue de compte, que personne ne voit de toute façon', async () => {
        assert.deepEqual(await placeOf(['view:profile'], []), ['view:profile']);
    });
});
