import {
    countMovableCells,
    FeatureError,
    movableCellsOf,
    resealCells,
    type FeatureItemsMove
} from '@deveye/types/sdk/server';

import type { NotesRepo } from './repo';
import { notesTree } from './copy';

/**
 * Le changement d'espace d'une note. Une note est une ligne : son corps est le
 * seul blob à resceller, et son classement ne la suit pas, un dossier
 * appartenant à l'espace qu'elle quitte.
 *
 * Les cellules à resceller viennent de l'arbre de `copy.ts`, la seule liste à tenir.
 */
const CELLS = movableCellsOf(notesTree);

export const notesMove: FeatureItemsMove<NotesRepo> = {
    async plan({ q, itemId }) {
        const noteId = Number(itemId);
        const rows = await q.query<{ folder_id: number | null }>('SELECT folder_id FROM notes WHERE id = ?', [noteId]);
        return {
            // Une note privée est refusée en amont par `shareable` : son corps
            // est chiffré par le mot de passe de son auteur.
            blockers: [],
            drops: rows[0]?.folder_id != null ? ['Son dossier, qui appartient à cet espace'] : [],
            rows: await countMovableCells(q, CELLS, noteId)
        };
    },

    async apply({ q, itemId, fromWorkspaceId, toWorkspaceId, ciphers }) {
        const noteId = Number(itemId);
        await resealCells(q, CELLS, noteId, ciphers);
        // À la fin de la liste de son nouvel espace, hors dossier : arriver au
        // milieu du classement d'un autre serait une surprise, et le dossier
        // d'origine n'existe pas là-bas.
        const next = await q.query<{ next: number }>(
            'SELECT COALESCE(MAX(sort_order) + 1, 0) AS next FROM notes WHERE workspace_id = ? AND folder_id IS NULL',
            [toWorkspaceId]
        );
        const res = await q.execute(
            `UPDATE notes SET workspace_id = ?, folder_id = NULL, sort_order = ?
              WHERE id = ? AND workspace_id = ?`,
            [toWorkspaceId, Number(next[0]?.next ?? 0), noteId, fromWorkspaceId]
        );
        if (res.affectedRows !== 1) {
            throw new FeatureError('not_found', 'Cette note n’est plus dans cet espace : déplacement annulé.');
        }
    }
};
