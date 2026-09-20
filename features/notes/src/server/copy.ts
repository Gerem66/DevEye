import type { FeatureItemsCopy, ItemTree } from '@deveye/types/sdk/server';

import type { NotesRepo } from './repo';

/**
 * Ce dont une note est faite : une ligne, et son corps pour seul blob. C'est la
 * liste que le déplacement rescelle et que la copie emporte.
 *
 * ⚠️ À tenir à jour : toute nouvelle colonne chiffrée suspendue à une note doit
 * y figurer (`sealed`), sinon un déplacement la laisse sous l'ancienne clé, où
 * elle devient illisible, et une copie l'emporte sous une clé que la destination
 * n'a pas. Rien ne peut le détecter, un blob chiffré est indistinguable d'un
 * autre.
 */
export const notesTree: ItemTree = [
    {
        table: 'notes',
        idColumn: 'id',
        ownerColumn: 'id',
        workspaceColumn: 'workspace_id',
        userColumn: 'user_id',
        orderColumn: 'sort_order',
        sealed: ['content'],
        // Un dossier appartient à l'espace quitté, et la copie naît aujourd'hui.
        omit: ['folder_id', 'created', 'updated'],
        tier: { column: 'is_private', open: 0, private: 1 }
    }
];

export const notesCopy: FeatureItemsCopy<NotesRepo> = {
    tree: notesTree,
    async plan({ q, itemId }) {
        const rows = await q.query<{ folder_id: number | null }>('SELECT folder_id FROM notes WHERE id = ?', [
            Number(itemId)
        ]);
        return {
            blockers: [],
            drops: rows[0]?.folder_id != null ? ['Son dossier, qui appartient à cet espace'] : []
        };
    }
};
