import {
    countMovableCells,
    FeatureError,
    movableCellsOf,
    resealCells,
    type FeatureItemsMove
} from '@deveye/types/sdk/server';

import { whiteboard } from './_shared';
import { whiteboardTree } from './copy';
import type { WhiteboardRepo } from './repo';

/** Les cellules à resceller viennent de l'arbre de `copy.ts`, la seule liste à tenir. */
const CELLS = movableCellsOf(whiteboardTree);

const FULL =
    'L’offre du propriétaire de cet espace n’a plus la place pour ce tableau et ses images : libérez de la place ou passez à une offre supérieure.';

/**
 * Le changement d'espace d'un tableau : sa ligne rescellée sous la clé de
 * l'espace d'arrivée. Ses images ne bougent pas, scellées par la clé du module.
 * La séance en cours se ferme d'abord, écrite : ses participants quittent le
 * tableau.
 */
export const whiteboardMove: FeatureItemsMove<WhiteboardRepo> = {
    async plan({ q, repo, itemId, fromWorkspaceId, toWorkspaceId }) {
        const boardId = Number(itemId);
        const row = await repo.boards.findById(boardId);
        const blockers: string[] = [];
        if (row !== null) {
            const bytes = Number(row.scene_bytes) + Number(row.preview_bytes) + Number(row.files_bytes);
            try {
                // Chez le même propriétaire, rien ne change de réserve.
                await whiteboard()
                    .quotaFor(toWorkspaceId)
                    .assert('storage', async (owned) =>
                        owned.includes(fromWorkspaceId) ? 0 : (await repo.boards.storedBytesIn(owned)) + bytes
                    );
            } catch (error) {
                if ((error as { code?: string }).code !== 'quota_exceeded') throw error;
                blockers.push(FULL);
            }
        }
        return {
            blockers,
            drops:
                whiteboard().sessions.participants(boardId) > 0
                    ? ['La séance en cours : ses participants quittent le tableau, rien de dessiné n’est perdu']
                    : [],
            rows: await countMovableCells(q, CELLS, boardId)
        };
    },

    async apply({ q, itemId, fromWorkspaceId, toWorkspaceId, ciphers }) {
        const boardId = Number(itemId);
        await whiteboard().sessions.close(boardId, 'moved');
        await resealCells(q, CELLS, boardId, ciphers);
        const res = await q.execute(
            'UPDATE ft_whiteboard_boards SET workspace_id = ? WHERE id = ? AND workspace_id = ?',
            [toWorkspaceId, boardId, fromWorkspaceId]
        );
        if (res.affectedRows !== 1) {
            throw new FeatureError('not_found', 'Ce tableau n’est plus dans cet espace : déplacement annulé.');
        }
    }
};
