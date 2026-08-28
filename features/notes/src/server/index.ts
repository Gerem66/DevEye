import type { FeatureServer } from '@deveye/types/sdk/server';

import { notesHandlers } from './handlers';
import { createRepo, type NotesRepo } from './repo';
import { tryDecryptPayload } from './_shared';

/**
 * L'entrée serveur du module. Pas de `migrationsDir` : les tables des Notes
 * datent du socle (014 et 015, complétées jusqu'à la 036, rattachées à
 * l'espace par la 048) et n'en bougeront jamais ; une nouvelle table du
 * module inaugurerait `src/server/migrations/` avec le préfixe `ft_notes_`.
 *
 * Pas de `createService` : rien ne tourne en fond.
 *
 * `items` est ce que le partage sait des notes sans ouvrir la feature : le
 * domicile d'une note visible d'ici (le sien, ou l'espace qui la projette),
 * son titre déchiffré par le codec ouvert de l'espace appelant, et si elle
 * peut être projetée. `shareTier: 'perItem'` l'exige ; le boot refuse un
 * module qui déclare sans l'offrir.
 */
export const serverEntry: FeatureServer<NotesRepo> = {
    createRepo,
    features: notesHandlers,
    items: {
        homeOf: async (repo, itemId, workspaceId) =>
            (await repo.findVisible(itemId, workspaceId))?.workspace_id ?? null,
        // Le titre vit dans le blob chiffré ; une note privée (étage gardé),
        // un blob illisible ou une note disparue valent `null`. Le titre vide
        // se nomme comme partout à l'écran.
        labelOf: async (repo, cipher, itemId, workspaceId) => {
            const row = await repo.findNote(itemId, workspaceId);
            if (!row || row.is_private === 1) return null;
            const payload = await tryDecryptPayload(cipher, row.content);
            if (!payload) return null;
            return payload.title.length > 0 ? payload.title : 'Sans titre';
        },
        // Le palier, ligne à ligne : une note privée est chiffrée par le mot
        // de passe de son auteur, qu'aucun autre espace ne détient. La
        // projeter ouvrirait une fenêtre sur rien ; `share.set` refuse en le
        // disant. Appelé avec le domicile de la note.
        shareable: async (repo, itemId, workspaceId) => {
            const row = await repo.findNote(itemId, workspaceId);
            return row !== null && row.is_private === 0;
        }
    }
};
