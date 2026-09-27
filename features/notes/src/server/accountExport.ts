import type { FeatureAccountExport } from '@deveye/types/sdk/server';

import type { NotesRepo } from './repo';

export const notesAccountExport: FeatureAccountExport<NotesRepo> = {
    tables: {
        notes: {
            file: 'notes.json',
            where: 'workspace_id = ?',
            key: ['id'],
            sealed: ['content'],
            json: ['content'],
            dates: { archived_at: 's', updated: 's', created: 's' }
        },
        note_folders: {
            file: 'dossiers.json',
            where: 'workspace_id = ?',
            key: ['id'],
            sealed: ['content'],
            json: ['content'],
            dates: { created: 's' }
        }
    }
};
