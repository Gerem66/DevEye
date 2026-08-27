import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { z, ZodType } from 'zod';

import {
    notesAdd,
    notesArchive,
    notesCount,
    notesDelete,
    notesEdit,
    notesFolderAdd,
    notesFolderDelete,
    notesFolderList,
    notesFolderRename,
    notesFolderReorder,
    notesGet,
    notesList,
    notesReorder,
    notesRestore
} from '../contracts/commands';
import type { NoteBlock, NoteFolderRow, NoteRow } from '../contracts/domain';
import { FeatureError, type SdkFeatureContext } from '@deveye/types/sdk/server';
import { createTestContext } from '@deveye/types/sdk/testing';

import { notesHandlers } from './handlers';
import type { NotesRepo } from './repo';

/**
 * Les handlers du module, sur le harnais du SDK.
 *
 * Ce qui mérite d'être tenu, c'est le **masque** et le **verrou** (une note
 * privée listée session scellée ne livre ni titre ni corps, et ses chemins
 * d'écriture répondent `locked`), la **règle des espaces** (pas de note privée
 * hors de l'espace personnel), le **deux temps** de la suppression (archive
 * d'abord, `conflict` sinon) et le **rangement** des dossiers (une suppression
 * range les orphelines en fin de « Sans dossier »). Rien de tout cela ne lève
 * ailleurs : un masque qui fuit ne casse aucun autre test, il montre juste un
 * titre de trop.
 *
 * Le verrou se teste par `unlocked: false` : le harnais répond alors non à
 * `secrecy.isUnlocked()` (la garde `assertPrivateUnlocked` des écritures) ET
 * scelle son cipher `'private'` comme le vrai (`decrypt` lève `locked`,
 * `tryDecrypt` rend `null`), parce que c'est le cipher, et non une garde, qui
 * refuse `notes.get` sur une note privée scellée (« picking the cipher IS the
 * access control »). L'étage ouvert reste l'identité : les dossiers et les
 * notes ordinaires se lisent toujours.
 */

/** Le handler d'un contrat, typé par ce contrat (le registre est hétérogène). */
function handlerFor<C extends { command: string; input: ZodType; output: ZodType }>(contract: C) {
    const def = notesHandlers.find((h) => h.command === contract.command);
    assert.ok(def, `handler ${contract.command} manquant`);
    return def.handler as (
        ctx: SdkFeatureContext<NotesRepo>,
        input: z.output<C['input']>
    ) => Promise<z.input<C['output']>>;
}

interface FakeRepo extends NotesRepo {
    notes: NoteRow[];
    folders: NoteFolderRow[];
}

const now = () => Math.floor(Date.now() / 1000);

/**
 * Un dépôt en mémoire, même contrat que le vrai. Les tableaux sont mutés en
 * place, jamais réassignés : les tests lisent `repo.notes` après coup. Il
 * reproduit ce que la base fait toute seule : le `ON DELETE SET NULL` de la
 * clé étrangère des dossiers, et le rang « en fin de dossier » d'une note
 * créée ou restaurée.
 */
function fakeRepo(): FakeRepo {
    let noteSeq = 0;
    let folderSeq = 0;
    const nextSortOrder = (rows: NoteRow[], workspaceId: number, folderId: number | null) => {
        const ranks = rows
            .filter((r) => r.workspace_id === workspaceId && r.archived_at === null && r.folder_id === folderId)
            .map((r) => r.sort_order);
        return ranks.length === 0 ? 0 : Math.max(...ranks) + 1;
    };
    return {
        notes: [],
        folders: [],
        async listNotes(workspaceId) {
            return this.notes
                .filter((r) => r.workspace_id === workspaceId)
                .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
        },
        async countActiveNotes(workspaceId) {
            return this.notes.filter((r) => r.workspace_id === workspaceId && r.archived_at === null).length;
        },
        async findNote(id, workspaceId) {
            return this.notes.find((r) => r.id === id && r.workspace_id === workspaceId) ?? null;
        },
        async createNote({ userId, workspaceId, folderId, content, isPrivate }) {
            const row: NoteRow = {
                id: ++noteSeq,
                user_id: userId,
                workspace_id: workspaceId,
                folder_id: folderId,
                content,
                sort_order: nextSortOrder(this.notes, workspaceId, folderId),
                is_private: isPrivate ? 1 : 0,
                archived_at: null,
                updated: now(),
                created: now()
            };
            this.notes.push(row);
            return row;
        },
        async updateNote(id, workspaceId, { folderId, content, isPrivate }) {
            const row = await this.findNote(id, workspaceId);
            if (!row) return null;
            row.folder_id = folderId;
            row.content = content;
            row.is_private = isPrivate ? 1 : 0;
            row.updated = now();
            return row;
        },
        async reorderNotes(workspaceId, folderId, noteIds) {
            for (const [i, id] of noteIds.entries()) {
                const row = await this.findNote(id, workspaceId);
                if (!row) continue;
                row.folder_id = folderId;
                row.sort_order = i;
            }
        },
        async archiveNote(id, workspaceId, at) {
            const row = await this.findNote(id, workspaceId);
            if (!row) return false;
            row.archived_at = at;
            return true;
        },
        async restoreNote(id, workspaceId) {
            const row = await this.findNote(id, workspaceId);
            if (!row) return false;
            row.sort_order = nextSortOrder(this.notes, workspaceId, row.folder_id);
            row.archived_at = null;
            return true;
        },
        async deleteNote(id, workspaceId) {
            const i = this.notes.findIndex((r) => r.id === id && r.workspace_id === workspaceId);
            if (i === -1) return false;
            this.notes.splice(i, 1);
            return true;
        },
        async listFolders(workspaceId) {
            return this.folders
                .filter((r) => r.workspace_id === workspaceId)
                .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
        },
        async findFolder(id, workspaceId) {
            return this.folders.find((r) => r.id === id && r.workspace_id === workspaceId) ?? null;
        },
        async createFolder({ userId, workspaceId, content }) {
            const ranks = this.folders.filter((r) => r.workspace_id === workspaceId).map((r) => r.sort_order);
            const row: NoteFolderRow = {
                id: ++folderSeq,
                user_id: userId,
                workspace_id: workspaceId,
                content,
                sort_order: ranks.length === 0 ? 0 : Math.max(...ranks) + 1,
                created: now()
            };
            this.folders.push(row);
            return row;
        },
        async updateFolder(id, workspaceId, content) {
            const row = await this.findFolder(id, workspaceId);
            if (!row) return null;
            row.content = content;
            return row;
        },
        async reorderFolders(workspaceId, ids) {
            for (const [i, id] of ids.entries()) {
                const row = await this.findFolder(id, workspaceId);
                if (row) row.sort_order = i;
            }
            return this.listFolders(workspaceId);
        },
        async deleteFolder(id, workspaceId) {
            const i = this.folders.findIndex((r) => r.id === id && r.workspace_id === workspaceId);
            if (i === -1) return false;
            this.folders.splice(i, 1);
            // Le `ON DELETE SET NULL` de la clé étrangère : les notes du dossier
            // gardent leur rang, c'est au handler de les ranger.
            for (const row of this.notes) if (row.folder_id === id) row.folder_id = null;
            return true;
        }
    };
}

/** Le refus attendu d'une session scellée : `locked`, et rien d'autre. */
function isLocked(e: unknown): boolean {
    return e instanceof FeatureError && e.code === 'locked';
}

function isCode(code: FeatureError['code']): (e: unknown) => boolean {
    return (e) => e instanceof FeatureError && e.code === code;
}

const text = (t: string): NoteBlock => ({ type: 'text', text: t });
const check = (t: string, done: boolean): NoteBlock => ({ type: 'check', text: t, done });

const DRAFT = { title: 'Courses', folderId: null, blocks: [text('Lait'), check('Pain', true)], private: false };
const PRIVATE_DRAFT = { ...DRAFT, title: 'Journal', blocks: [text('Secret')], private: true };

describe('notes.list', () => {
    it('masque une note privée quand la session est scellée, et la révèle déverrouillée', async () => {
        const repo = fakeRepo();
        const open = createTestContext({ repo });
        await handlerFor(notesAdd)(open, { note: DRAFT });
        const added = await handlerFor(notesAdd)(open, { note: PRIVATE_DRAFT });

        const locked = createTestContext({ repo, unlocked: false });
        const listed = await handlerFor(notesList)(locked, {});
        assert.equal(listed.notes.length, 2);
        const masked = listed.notes.find((n) => n.id === added.note.id);
        assert.ok(masked);
        assert.equal(masked.masked, true);
        assert.equal(masked.private, true);
        assert.equal(masked.title, '');
        assert.equal(masked.preview, undefined);
        assert.equal(masked.checkTotal, 0);
        // Rien du corps ne sort : ni dans le résumé, ni ailleurs dans la réponse.
        assert.ok(!JSON.stringify(listed).includes('Secret'));
        assert.ok(!JSON.stringify(listed).includes('Journal'));
        // La note ordinaire, elle, se lit normalement, avec ses cases.
        const clear = listed.notes.find((n) => n.id !== added.note.id);
        assert.equal(clear?.title, 'Courses');
        assert.equal(clear?.preview, 'Lait');
        assert.deepEqual([clear?.checkTotal, clear?.checkDone], [1, 1]);

        const revealed = await handlerFor(notesList)(open, {});
        const shown = revealed.notes.find((n) => n.id === added.note.id);
        assert.equal(shown?.masked, false);
        assert.equal(shown?.title, 'Journal');
        assert.equal(shown?.preview, 'Secret');
    });

    it("sépare l'actif de l'archive, l'archive du plus récent au plus ancien", async () => {
        const repo = fakeRepo();
        const ctx = createTestContext({ repo });
        const a = await handlerFor(notesAdd)(ctx, { note: { ...DRAFT, title: 'A' } });
        const b = await handlerFor(notesAdd)(ctx, { note: { ...DRAFT, title: 'B' } });
        await handlerFor(notesAdd)(ctx, { note: { ...DRAFT, title: 'C' } });
        await handlerFor(notesArchive)(ctx, { noteId: a.note.id });
        await handlerFor(notesArchive)(ctx, { noteId: b.note.id });
        // Deux archivages dans la même seconde : on force l'ordre des dates.
        repo.notes.find((r) => r.id === a.note.id)!.archived_at = 100;
        repo.notes.find((r) => r.id === b.note.id)!.archived_at = 200;

        const active = await handlerFor(notesList)(ctx, {});
        assert.deepEqual(
            active.notes.map((n) => n.title),
            ['C']
        );
        const archived = await handlerFor(notesList)(ctx, { archived: true });
        assert.deepEqual(
            archived.notes.map((n) => n.title),
            ['B', 'A']
        );
        assert.ok(archived.notes.every((n) => n.archivedAt !== null));
    });
});

describe('notes.count', () => {
    it('compte les actives seulement, privées comprises, même scellé, et par espace', async () => {
        const repo = fakeRepo();
        const ctx = createTestContext({ repo });
        await handlerFor(notesAdd)(ctx, { note: DRAFT });
        await handlerFor(notesAdd)(ctx, { note: PRIVATE_DRAFT });
        const archived = await handlerFor(notesAdd)(ctx, { note: { ...DRAFT, title: 'Vieille' } });
        await handlerFor(notesArchive)(ctx, { noteId: archived.note.id });

        assert.deepEqual(await handlerFor(notesCount)(createTestContext({ repo, unlocked: false }), {}), { count: 2 });
        assert.deepEqual(await handlerFor(notesCount)(createTestContext({ repo, workspaceId: 7 }), {}), {
            count: 0
        });
    });
});

describe('le verrou', () => {
    it('répond `locked` à notes.get sur une note privée scellée, jamais sur une ordinaire', async () => {
        const repo = fakeRepo();
        const open = createTestContext({ repo });
        const clear = await handlerFor(notesAdd)(open, { note: DRAFT });
        const secret = await handlerFor(notesAdd)(open, { note: PRIVATE_DRAFT });

        const locked = createTestContext({ repo, unlocked: false });
        await assert.rejects(handlerFor(notesGet)(locked, { noteId: secret.note.id }), isLocked);
        const read = await handlerFor(notesGet)(locked, { noteId: clear.note.id });
        assert.equal(read.note.title, 'Courses');
    });

    it("refuse d'éditer, d'archiver, de restaurer ou de détruire une note privée qu'elle ne voit pas", async () => {
        const repo = fakeRepo();
        const open = createTestContext({ repo });
        const secret = await handlerFor(notesAdd)(open, { note: PRIVATE_DRAFT });
        const gone = await handlerFor(notesAdd)(open, { note: { ...PRIVATE_DRAFT, title: 'Archivée' } });
        await handlerFor(notesArchive)(open, { noteId: gone.note.id });

        // La garde seule, sans cipher scellé : c'est elle qui protège ces
        // chemins, qui n'ont pas besoin de lire le corps.
        const locked = createTestContext({ repo, unlocked: false });
        await assert.rejects(handlerFor(notesEdit)(locked, { noteId: secret.note.id, note: PRIVATE_DRAFT }), isLocked);
        await assert.rejects(handlerFor(notesArchive)(locked, { noteId: secret.note.id }), isLocked);
        await assert.rejects(handlerFor(notesRestore)(locked, { noteId: gone.note.id }), isLocked);
        await assert.rejects(handlerFor(notesDelete)(locked, { noteId: gone.note.id }), isLocked);
        assert.equal(repo.notes.length, 2);
        assert.equal(locked.recorded.audits.length, 0);
    });

    it('laisse repositionner une note masquée : le rang ne touche pas au corps', async () => {
        const repo = fakeRepo();
        const open = createTestContext({ repo });
        const a = await handlerFor(notesAdd)(open, { note: DRAFT });
        const secret = await handlerFor(notesAdd)(open, { note: PRIVATE_DRAFT });

        const locked = createTestContext({ repo, unlocked: false });
        const res = await handlerFor(notesReorder)(locked, { folderId: null, noteIds: [secret.note.id, a.note.id] });
        assert.deepEqual(res.noteIds, [secret.note.id, a.note.id]);
        assert.equal(repo.notes.find((r) => r.id === secret.note.id)?.sort_order, 0);
        assert.equal(repo.notes.find((r) => r.id === a.note.id)?.sort_order, 1);
    });
});

describe('la règle des espaces', () => {
    it('refuse une note privée dans un espace partagé, à la création comme à la bascule', async () => {
        const repo = fakeRepo();
        const shared = createTestContext({ repo, kind: 'shared' });
        await assert.rejects(handlerFor(notesAdd)(shared, { note: PRIVATE_DRAFT }), isCode('validation'));
        assert.equal(repo.notes.length, 0);

        const added = await handlerFor(notesAdd)(shared, { note: DRAFT });
        await assert.rejects(
            handlerFor(notesEdit)(shared, { noteId: added.note.id, note: { ...DRAFT, private: true } }),
            isCode('validation')
        );
        assert.equal(repo.notes[0].is_private, 0);

        // Dans l'espace personnel, la même bascule passe et re-chiffre à l'étage gardé.
        const personal = createTestContext({ repo });
        const flipped = await handlerFor(notesEdit)(personal, {
            noteId: added.note.id,
            note: { ...DRAFT, private: true }
        });
        assert.equal(flipped.note.private, true);
        assert.equal(repo.notes[0].is_private, 1);
    });
});

describe('notes.add / notes.get / notes.edit', () => {
    it("chiffre titre et blocs ensemble, laisse le reste en clair, et relit tel qu'écrit", async () => {
        const repo = fakeRepo();
        const ctx = createTestContext({ repo });
        const folder = await handlerFor(notesFolderAdd)(ctx, { name: 'Maison' });

        const added = await handlerFor(notesAdd)(ctx, { note: { ...DRAFT, folderId: folder.folder.id } });
        assert.equal(added.note.id, 1);
        assert.equal(added.note.folderId, folder.folder.id);
        assert.equal(added.note.sortOrder, 0);
        // Le harnais chiffre à l'identité : la charge doit être passée par le
        // cipher, en JSON, avec seulement ce qui est sensible ; le dossier, le
        // rang et le drapeau restent des colonnes claires.
        assert.deepEqual(JSON.parse(repo.notes[0].content), { title: DRAFT.title, blocks: DRAFT.blocks });
        assert.equal(repo.notes[0].folder_id, folder.folder.id);
        assert.equal(ctx.recorded.audits.at(-1)?.action, 'note.create');

        const read = await handlerFor(notesGet)(ctx, { noteId: added.note.id });
        assert.deepEqual(read.note.blocks, DRAFT.blocks);
        await assert.rejects(handlerFor(notesGet)(ctx, { noteId: 99 }), isCode('not_found'));

        const edited = await handlerFor(notesEdit)(ctx, {
            noteId: added.note.id,
            note: { ...DRAFT, title: 'Courses du samedi', folderId: null }
        });
        assert.equal(edited.note.title, 'Courses du samedi');
        assert.equal(edited.note.folderId, null);
        assert.equal(ctx.recorded.audits.at(-1)?.action, 'note.edit');

        // Un dossier d'un autre espace n'existe pas d'ici.
        await assert.rejects(handlerFor(notesAdd)(ctx, { note: { ...DRAFT, folderId: 42 } }), isCode('not_found'));
        await assert.rejects(handlerFor(notesEdit)(ctx, { noteId: 99, note: DRAFT }), isCode('not_found'));
    });
});

describe('archive puis suppression', () => {
    it("refuse de détruire une note active (`conflict`), l'accepte une fois archivée, et sait la restaurer en fin de dossier", async () => {
        const repo = fakeRepo();
        const ctx = createTestContext({ repo });
        const first = await handlerFor(notesAdd)(ctx, { note: { ...DRAFT, title: 'Première' } });
        const second = await handlerFor(notesAdd)(ctx, { note: { ...DRAFT, title: 'Seconde' } });

        await assert.rejects(handlerFor(notesDelete)(ctx, { noteId: first.note.id }), isCode('conflict'));
        assert.equal(repo.notes.length, 2);

        await handlerFor(notesArchive)(ctx, { noteId: first.note.id });
        assert.equal(ctx.recorded.audits.at(-1)?.action, 'note.archive');
        assert.deepEqual(await handlerFor(notesCount)(ctx, {}), { count: 1 });

        // Restaurée, elle passe derrière la seconde : son ancien rang appartenait
        // à une liste qui a continué sans elle.
        await handlerFor(notesRestore)(ctx, { noteId: first.note.id });
        assert.equal(ctx.recorded.audits.at(-1)?.action, 'note.restore');
        const active = await handlerFor(notesList)(ctx, {});
        assert.deepEqual(
            active.notes.map((n) => n.title),
            ['Seconde', 'Première']
        );
        assert.ok(
            repo.notes.find((r) => r.id === first.note.id)!.sort_order >
                repo.notes.find((r) => r.id === second.note.id)!.sort_order
        );

        await handlerFor(notesArchive)(ctx, { noteId: first.note.id });
        const removed = await handlerFor(notesDelete)(ctx, { noteId: first.note.id });
        assert.equal(removed.noteId, first.note.id);
        assert.equal(repo.notes.length, 1);
        assert.equal(ctx.recorded.audits.at(-1)?.action, 'note.delete');
        await assert.rejects(handlerFor(notesDelete)(ctx, { noteId: first.note.id }), isCode('not_found'));
    });
});

describe('notes.reorder', () => {
    it("range le dossier de destination dans l'ordre donné et ignore ce qui n'est pas à lui", async () => {
        const repo = fakeRepo();
        const ctx = createTestContext({ repo });
        const folder = await handlerFor(notesFolderAdd)(ctx, { name: 'Travail' });
        const a = await handlerFor(notesAdd)(ctx, { note: DRAFT });
        const b = await handlerFor(notesAdd)(ctx, { note: DRAFT });
        const archived = await handlerFor(notesAdd)(ctx, { note: DRAFT });
        await handlerFor(notesArchive)(ctx, { noteId: archived.note.id });
        const foreign = await handlerFor(notesAdd)(createTestContext({ repo, workspaceId: 7 }), { note: DRAFT });

        const res = await handlerFor(notesReorder)(ctx, {
            folderId: folder.folder.id,
            noteIds: [b.note.id, archived.note.id, foreign.note.id, a.note.id]
        });
        assert.deepEqual(res, { folderId: folder.folder.id, noteIds: [b.note.id, a.note.id] });
        const rowB = repo.notes.find((r) => r.id === b.note.id)!;
        const rowA = repo.notes.find((r) => r.id === a.note.id)!;
        assert.deepEqual([rowB.folder_id, rowB.sort_order], [folder.folder.id, 0]);
        assert.deepEqual([rowA.folder_id, rowA.sort_order], [folder.folder.id, 1]);
        // L'archivée et l'étrangère n'ont pas bougé.
        assert.equal(repo.notes.find((r) => r.id === archived.note.id)!.folder_id, null);
        assert.equal(repo.notes.find((r) => r.id === foreign.note.id)!.workspace_id, 7);

        await assert.rejects(
            handlerFor(notesReorder)(ctx, { folderId: 42, noteIds: [a.note.id] }),
            isCode('not_found')
        );
    });
});

describe('les dossiers', () => {
    it("s'ajoutent en fin de liste, se renomment, se réordonnent, et sont chiffrés à l'étage ouvert", async () => {
        const repo = fakeRepo();
        const ctx = createTestContext({ repo });
        const home = await handlerFor(notesFolderAdd)(ctx, { name: '  Maison ' });
        const work = await handlerFor(notesFolderAdd)(ctx, { name: 'Travail' });
        assert.equal(home.folder.name, 'Maison');
        assert.deepEqual([home.folder.sortOrder, work.folder.sortOrder], [0, 1]);
        assert.deepEqual(JSON.parse(repo.folders[0].content), { name: 'Maison' });
        assert.equal(ctx.recorded.audits.at(-1)?.action, 'folder.create');

        // Les dossiers vivent à l'étage ouvert : une session scellée les lit.
        const listed = await handlerFor(notesFolderList)(createTestContext({ repo, unlocked: false }), {});
        assert.deepEqual(
            listed.folders.map((f) => f.name),
            ['Maison', 'Travail']
        );

        const renamed = await handlerFor(notesFolderRename)(ctx, { folderId: home.folder.id, name: 'Chez moi' });
        assert.equal(renamed.folder.name, 'Chez moi');
        assert.equal(ctx.recorded.audits.at(-1)?.action, 'folder.rename');
        await assert.rejects(handlerFor(notesFolderRename)(ctx, { folderId: 99, name: 'X' }), isCode('not_found'));

        const reordered = await handlerFor(notesFolderReorder)(ctx, {
            folderIds: [work.folder.id, 99, home.folder.id]
        });
        assert.deepEqual(
            reordered.folders.map((f) => [f.name, f.sortOrder]),
            [
                ['Travail', 0],
                ['Chez moi', 1]
            ]
        );
    });

    it('en supprimant un dossier, range ses notes en fin de « Sans dossier » sans en perdre une', async () => {
        const repo = fakeRepo();
        const ctx = createTestContext({ repo });
        const folder = await handlerFor(notesFolderAdd)(ctx, { name: 'Projets' });
        const a = await handlerFor(notesAdd)(ctx, { note: { ...DRAFT, title: 'A' } });
        const b = await handlerFor(notesAdd)(ctx, { note: { ...DRAFT, title: 'B' } });
        const c = await handlerFor(notesAdd)(ctx, { note: { ...DRAFT, title: 'C', folderId: folder.folder.id } });
        const d = await handlerFor(notesAdd)(ctx, { note: { ...DRAFT, title: 'D', folderId: folder.folder.id } });
        // Une archivée du dossier : elle est désolidarisée par la base, pas rangée.
        const old = await handlerFor(notesAdd)(ctx, {
            note: { ...DRAFT, title: 'Vieille', folderId: folder.folder.id }
        });
        await handlerFor(notesArchive)(ctx, { noteId: old.note.id });

        const removed = await handlerFor(notesFolderDelete)(ctx, { folderId: folder.folder.id });
        assert.equal(removed.folderId, folder.folder.id);
        assert.equal(repo.folders.length, 0);
        assert.equal(ctx.recorded.audits.at(-1)?.action, 'folder.delete');

        const rank = (id: number) => {
            const row = repo.notes.find((r) => r.id === id)!;
            return [row.folder_id, row.sort_order];
        };
        assert.deepEqual(rank(a.note.id), [null, 0]);
        assert.deepEqual(rank(b.note.id), [null, 1]);
        assert.deepEqual(rank(c.note.id), [null, 2]);
        assert.deepEqual(rank(d.note.id), [null, 3]);
        assert.equal(repo.notes.find((r) => r.id === old.note.id)!.folder_id, null);
        assert.deepEqual(await handlerFor(notesCount)(ctx, {}), { count: 4 });

        await assert.rejects(handlerFor(notesFolderDelete)(ctx, { folderId: folder.folder.id }), isCode('not_found'));
    });
});
