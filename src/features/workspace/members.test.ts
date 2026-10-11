import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ItemShareRow } from '@deveye/types';

import { dropSharesOf } from './members';

const share = (workspace_id: number, home_workspace_id: number, item_id: string): ItemShareRow => ({
    workspace_id,
    feature: 'notes',
    item_id,
    home_workspace_id,
    shared_by_user_id: 7,
    created: 0,
    sort_order: 0
});

describe('dropSharesOf', () => {
    it('retire chaque projection du membre, dans l’espace qui la recevait', async () => {
        const unshared: [number, string, string][] = [];
        const db = {
            itemSharing: {
                // Vers son espace personnel (9) depuis ici (3), et de chez lui vers ici.
                sharedByUserAround: async () => [share(9, 3, 'n1'), share(3, 9, 'n2')],
                unshare: async (workspaceId: number, feature: string, itemId: string) => {
                    unshared.push([workspaceId, feature, itemId]);
                }
            }
        } as never;

        assert.equal(await dropSharesOf(db, 7, 3), 2);
        assert.deepEqual(unshared, [
            [9, 'notes', 'n1'],
            [3, 'notes', 'n2']
        ]);
    });

    it('ne touche à rien sans projection', async () => {
        const db = {
            itemSharing: {
                sharedByUserAround: async () => [],
                unshare: async () => assert.fail('rien à retirer')
            }
        } as never;
        assert.equal(await dropSharesOf(db, 7, 3), 0);
    });
});
