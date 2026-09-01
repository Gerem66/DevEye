import {
    countMovableCells,
    FeatureError,
    resealCells,
    type FeatureItemsMove,
    type MovableCell
} from '@deveye/types/sdk/server';

import type { NotesRepo } from './repo';

/**
 * Le changement d'espace d'une note. Une note est une ligne : son corps est le
 * seul blob à resceller, et son classement ne la suit pas, un dossier
 * appartenant à l'espace qu'elle quitte.
 *
 * ⚠️ Liste à tenir à jour : toute nouvelle colonne chiffrée suspendue à une note
 * doit y figurer, sinon son contenu reste sous l'ancienne clé et devient
 * illisible. Rien ne peut le détecter, un blob chiffré est indistinguable d'un
 * autre.
 */
const CELLS: readonly MovableCell[] = [{ table: 'notes', idColumn: 'id', ownerColumn: 'id', column: 'content' }];

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
