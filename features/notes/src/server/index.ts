import type { FeatureServer } from '@deveye/types/sdk/server';

import { notesHandlers } from './handlers';
import { createRepo, type NotesRepo } from './repo';

/**
 * L'entrée serveur du module. Pas de `migrationsDir` : les tables des Notes
 * datent du socle (014 et 015, complétées jusqu'à la 036, rattachées à
 * l'espace par la 048) et n'en bougeront jamais ; une nouvelle table du
 * module inaugurerait `src/server/migrations/` avec le préfixe `ft_notes_`.
 *
 * Pas de `createService` : rien ne tourne en fond. Pas d'entrée `items` non
 * plus : le manifest déclare `shareTier: 'never'` par-dessus le `'perItem'`
 * du descripteur publié, parce que le listage n'est pas branché sur le
 * partage (voir `manifest.ts`). Le jour où il l'est, `items` arrive ici en
 * même temps que `ctx.sharing.scope()` dans `notes.list`.
 */
export const serverEntry: FeatureServer<NotesRepo> = {
    createRepo,
    features: notesHandlers
};
