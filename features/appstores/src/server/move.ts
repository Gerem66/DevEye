import {
    countMovableCells,
    FeatureError,
    itemDigestTaken,
    movableCellsOf,
    rekeyItemDigests,
    resealCells,
    type FeatureItemsMove
} from '@deveye/types/sdk/server';

import { appStoresTree, DUPLICATE } from './copy';
import type { AppStoresRepo } from './repo';

/**
 * Le changement d'espace d'une app : sa fiche, ses fiches de store et ses
 * avis, rescellés. Les chiffres du jour, leurs pays et les revenus ne portent
 * ni espace ni chiffre : ils suivent `app_id`. La source appartient à l'espace quitté et ne
 * suit pas : l'app arrive sans elle, donc sans synchronisation.
 */
const CELLS = movableCellsOf(appStoresTree);

export const appStoresMove: FeatureItemsMove<AppStoresRepo> = {
    async plan({ q, itemId, toWorkspaceId, cipher, keys }) {
        const appId = Number(itemId);
        // Une app du store déjà suivie là-bas : la base refuserait la seconde, autant le dire avant.
        const taken = await itemDigestTaken(q, appStoresTree, appId, { cipher, keys, workspaceId: toWorkspaceId });
        const sourced = await q.query<{ n: number }>(
            'SELECT COUNT(*) AS n FROM ft_appstores_listings WHERE app_id = ? AND source_id IS NOT NULL',
            [appId]
        );
        return {
            blockers: taken ? [DUPLICATE] : [],
            drops:
                Number(sourced[0]?.n ?? 0) > 0
                    ? [
                          'Sa source, qui appartient à cet espace : la synchronisation s’arrêtera jusqu’à ce qu’on en choisisse une là-bas'
                      ]
                    : [],
            rows: await countMovableCells(q, CELLS, appId)
        };
    },

    async apply({ q, itemId, fromWorkspaceId, toWorkspaceId, ciphers, keys }) {
        const appId = Number(itemId);
        await resealCells(q, CELLS, appId, ciphers);
        await rekeyItemDigests(
            q,
            appStoresTree,
            appId,
            { cipher: ciphers.to, keys, workspaceId: toWorkspaceId },
            { within: 'workspace' }
        );
        await q.execute(
            'UPDATE ft_appstores_listings SET workspace_id = ?, source_id = NULL WHERE app_id = ? AND workspace_id = ?',
            [toWorkspaceId, appId, fromWorkspaceId]
        );
        const next = await q.query<{ next: number }>(
            'SELECT COALESCE(MAX(sort_order) + 1, 0) AS next FROM ft_appstores_apps WHERE workspace_id = ?',
            [toWorkspaceId]
        );
        const res = await q.execute(
            'UPDATE ft_appstores_apps SET workspace_id = ?, sort_order = ? WHERE id = ? AND workspace_id = ?',
            [toWorkspaceId, Number(next[0]?.next ?? 0), appId, fromWorkspaceId]
        );
        if (res.affectedRows !== 1) {
            throw new FeatureError('not_found', 'Cette app n’est plus dans cet espace : déplacement annulé.');
        }
    }
};
