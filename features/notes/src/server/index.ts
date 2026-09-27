import type { FeatureServer } from '@deveye/types/sdk/server';

import { notesHandlers } from './handlers';
import { createRepo, type NotesRepo } from './repo';
import { notesCopy } from './copy';
import { notesMove } from './move';
import { tryDecryptPayload } from './_shared';
import { notesE2e } from './e2e';

/**
 * Pas de `migrationsDir` : les tables des Notes datent du socle de l'app.
 * Pas de `createService` : rien ne tourne en fond.
 *
 * `items` est ce que le partage sait des notes sans ouvrir la feature :
 * le domicile d'une note visible d'ici, son titre, et si elle peut être
 * projetée. `shareTier: 'perItem'` l'exige.
 */
export const serverEntry: FeatureServer<NotesRepo> = {
    createRepo,
    e2e: notesE2e,
    features: notesHandlers,
    items: {
        homeOf: async (repo, itemId, workspaceId) =>
            (await repo.findVisible(Number(itemId), workspaceId))?.workspace_id ?? null,
        // Le titre vit dans le blob chiffré : une note privée (étage gardé),
        // un blob illisible ou une note disparue valent `null`.
        labelOf: async (repo, cipher, itemId, workspaceId) => {
            const row = await repo.findNote(Number(itemId), workspaceId);
            if (!row || row.is_private === 1) return null;
            const payload = await tryDecryptPayload(cipher, row.content);
            if (!payload) return null;
            return payload.title.length > 0 ? payload.title : 'Sans titre';
        },
        // Une note privée est chiffrée par le mot de passe de son auteur,
        // qu'aucun autre espace ne détient : la projeter ouvrirait une fenêtre
        // sur rien.
        shareable: async (repo, itemId, workspaceId) => {
            const row = await repo.findNote(Number(itemId), workspaceId);
            return row !== null && row.is_private === 0;
        },
        move: notesMove,
        copy: notesCopy
    }
};
