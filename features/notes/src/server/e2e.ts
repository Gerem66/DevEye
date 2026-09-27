import type { FeatureE2eEntry } from '@deveye/types/sdk/server';

import type { Note, NoteBlock, NoteSummary } from '../contracts/domain';
import type { NotesRepo } from './repo';

const TITLE = 'Note d’essai de bout en bout';

function check(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

/** Une note ne se supprime qu'archivée ; déjà partie (la dernière étape), il n'y a plus rien à faire. */
async function archiveThenDelete(send: (command: string, input: unknown) => Promise<unknown>, noteId: number) {
    try {
        await send('notes.archive', { noteId });
        await send('notes.delete', { noteId });
    } catch (e) {
        if ((e as { code?: string }).code !== 'not_found') throw e;
    }
}

/** Une note, de la création à la suppression : l'aller-retour par le chiffrement, et rien en clair au repos. */
export const notesE2e: FeatureE2eEntry<NotesRepo> = {
    scenarios: [
        {
            id: 'lifecycle',
            label: 'Une note, de la création à la suppression',
            steps: [
                {
                    label: 'Créer une note',
                    run: async (ctx) => {
                        const { note } = await ctx.send<{ note: Note }>('notes.add', {
                            note: {
                                title: TITLE,
                                folderId: null,
                                private: false,
                                blocks: [
                                    { type: 'text', text: 'Premier jet.' },
                                    { type: 'check', text: 'À relire', done: false }
                                ]
                            }
                        });
                        ctx.state.set('noteId', note.id);
                        ctx.defer('Supprimer la note', () => archiveThenDelete(ctx.send, note.id));
                        return `Note ${note.id}`;
                    }
                },
                {
                    label: 'La modifier',
                    run: async (ctx) => {
                        await ctx.send('notes.edit', {
                            noteId: ctx.state.get('noteId'),
                            note: {
                                title: `${TITLE} (relue)`,
                                folderId: null,
                                private: false,
                                blocks: [
                                    { type: 'text', text: 'Premier jet.' },
                                    { type: 'check', text: 'À relire', done: true }
                                ]
                            }
                        });
                    }
                },
                {
                    label: 'La relire déchiffrée',
                    run: async (ctx) => {
                        const { note } = await ctx.send<{ note: Note }>('notes.get', {
                            noteId: ctx.state.get('noteId')
                        });
                        check(note.title === `${TITLE} (relue)`, 'Le titre relu n’est pas celui écrit');
                        const check0 = note.blocks.find((b: NoteBlock) => b.type === 'check');
                        check(check0?.type === 'check' && check0.done, 'La case cochée ne l’est plus à la relecture');
                    }
                },
                {
                    label: 'Vérifier qu’elle est chiffrée au repos',
                    run: async (ctx) => {
                        const row = await ctx.repo.findNote(ctx.state.get('noteId') as number, ctx.account.workspaceId);
                        check(row, 'La note est introuvable en base');
                        check(!row.content.includes('Premier jet'), 'Le contenu est lisible en base');
                    }
                },
                {
                    label: 'L’archiver puis la supprimer',
                    run: async (ctx) => {
                        const noteId = ctx.state.get('noteId') as number;
                        await ctx.send('notes.archive', { noteId });
                        await ctx.send('notes.delete', { noteId });
                        const { notes } = await ctx.send<{ notes: NoteSummary[] }>('notes.list', {});
                        check(!notes.some((n) => n.id === noteId), 'La note est encore listée');
                    }
                }
            ]
        }
    ]
};
