import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    Button,
    ensureSecrecyUnlocked,
    humanizeError,
    invalidate,
    OpenPopup,
    TextInput,
    useActiveWorkspace,
    useLiveSegment,
    useResourceVersion,
    useSecrecy,
    withSecrecy
} from 'deveye-sdk-client';
import type { Note, NoteFolder, NoteSummary } from '../contracts/domain';

import { api } from './api';
import ArchivePopup, { NOTE_ARCHIVE_POPUP } from './ArchivePopup';
import ConfirmPopup, { NOTE_CONFIRM_POPUP, type ConfirmInput } from './ConfirmPopup';
import FolderNamePopup, { FOLDER_NAME_POPUP, type FolderNameInput, type FolderNameResult } from './FolderNamePopup';
import NoteEditor, {
    NOTE_EDITOR_POPUP,
    type NoteDraft,
    type NoteEditorInput,
    type NoteEditorResult
} from './NoteEditor';
import NoteGrid from './NoteGrid';
import styles from './style.module.css';

/**
 * Les notes projetées depuis un autre espace passent après les locales : leur
 * rang est celui de leur domicile, et les mêler au classement d'ici les ferait
 * paraître déplaçables.
 */
function byOrder(a: NoteSummary, b: NoteSummary): number {
    return Number(a.foreign) - Number(b.foreign) || a.sortOrder - b.sortOrder || a.id - b.id;
}

/**
 * L'espace vient du SDK, pas des props : c'est lui qui borne les notes, et son
 * changement recharge la liste.
 */
function Notes() {
    const workspaceId = useActiveWorkspace()?.id ?? null;
    const [loaded, setLoaded] = useState(false);
    const [search, setSearch] = useState('');
    const [notes, setNotes] = useState<NoteSummary[]>([]);
    const [folders, setFolders] = useState<NoteFolder[]>([]);
    const [actionError, setActionError] = useState<string | null>(null);
    /** La note ouverte dans l'éditeur : c'est le niveau profond des Notes. */
    const [openNoteId, setOpenNoteId] = useState<number | null>(null);
    useLiveSegment('l1', openNoteId === null ? null : String(openNoteId));
    const reloadRef = useRef<Promise<void> | null>(null);
    const draggingRef = useRef<NoteSummary | null>(null);
    const { unlocked } = useSecrecy();
    const wasUnlocked = useRef(unlocked);

    const reload = useCallback(async () => {
        if (reloadRef.current) return reloadRef.current;
        const task = (async () => {
            try {
                const [notesRes, foldersRes] = await Promise.all([
                    withSecrecy(() => api.send('notes.list', {})),
                    api.send('notes.folderList', {})
                ]);
                setNotes(notesRes.notes);
                setFolders(foldersRes.folders);
            } catch {
                setNotes([]);
                setFolders([]);
            } finally {
                setLoaded(true);
            }
        })();
        reloadRef.current = task;
        try {
            await task;
        } finally {
            reloadRef.current = null;
        }
    }, [workspaceId]);

    useEffect(() => {
        setLoaded(false);
        setNotes([]);
        setFolders([]);
        setActionError(null);
        void reload();
    }, [reload]);

    /**
     * Re-list whenever the session flips lock state, wherever that came from:
     * unlocking swaps the padlock placeholders for real titles, re-locking masks
     * them again. Only the transition triggers a fetch, and `reload` de-duplicates.
     */
    useEffect(() => {
        if (unlocked === wasUnlocked.current) return;
        wasUnlocked.current = unlocked;
        void reload();
    }, [unlocked, reload]);

    /**
     * Une note écrite par quelqu'un d'autre apparaît sans recharger. Sans danger
     * pour le verrou : `notes.list` ne lit que la clé ouverte (les notes privées y
     * reviennent masquées), donc cette relecture ne peut pas faire surgir une
     * demande de mot de passe.
     */
    const listVersion = useResourceVersion('notes.list');
    useEffect(() => {
        if (listVersion === 0) return;
        void reload();
    }, [listVersion, reload]);

    const upsert = useCallback((note: Note) => {
        const summary = toSummary(note);
        setNotes((prev) => {
            const exists = prev.some((n) => n.id === summary.id);
            return exists ? prev.map((n) => (n.id === summary.id ? summary : n)) : [summary, ...prev];
        });
    }, []);

    const saveDraft = useCallback(
        async (existing: Note | null, draft: NoteDraft) => {
            try {
                if (existing) {
                    const res = await withSecrecy(() => api.send('notes.edit', { noteId: existing.id, note: draft }));
                    upsert(res.note);
                } else {
                    const res = await withSecrecy(() => api.send('notes.add', { note: draft }));
                    upsert(res.note);
                    invalidate('notes.count');
                }
            } catch (e) {
                setActionError(humanizeError(e, 'Enregistrement impossible.'));
            }
        },
        [workspaceId, upsert]
    );

    const openEditor = useCallback(
        async (summary: NoteSummary | null, targetFolderId: number | null = null) => {
            setActionError(null);

            let existing: Note | null = null;
            if (summary) {
                try {
                    const res = await withSecrecy(() => api.send('notes.get', { noteId: summary.id }));
                    existing = res.note;
                } catch (e) {
                    setActionError(humanizeError(e, 'Impossible d’ouvrir la note.'));
                    return;
                }
            }

            const input: NoteEditorInput = { note: existing, folderId: existing ? existing.folderId : targetFolderId };
            // Déclaré le temps de l'édition, pour que deux membres sur la même
            // note se voient.
            setOpenNoteId(existing?.id ?? null);
            const result = await OpenPopup<NoteEditorResult>(NOTE_EDITOR_POPUP, input);
            setOpenNoteId(null);
            if (result === null) return;

            // 'delete' arrives already confirmed by the editor, and archives rather
            // than destroys: the irreversible step belongs to the archive popup.
            if (result === 'delete' && existing) {
                try {
                    await withSecrecy(() => api.send('notes.archive', { noteId: existing!.id }));
                    setNotes((prev) => prev.filter((n) => n.id !== existing!.id));
                    invalidate('notes.count');
                } catch (e) {
                    setActionError(humanizeError(e, 'Archivage impossible.'));
                }
                return;
            }

            if (typeof result === 'object') await saveDraft(existing, result);
        },
        [workspaceId, saveDraft]
    );

    /**
     * Enter the master password, then re-list so private notes swap their padlock
     * placeholders for real titles and previews. The refresh stays explicit: in
     * "validate on every action" mode the session is never held unlocked, so the
     * lock-state effect above sees no transition to react to.
     */
    const revealPrivate = useCallback(async (): Promise<void> => {
        setActionError(null);
        try {
            await ensureSecrecyUnlocked();
        } catch {
            return; // prompt dismissed: leave the masked cards as they are
        }
        await reload();
    }, [reload]);

    /**
     * A masked card only *reveals*: chaining straight into the editor would open a
     * note blind, since its title is precisely what isn't known yet.
     */
    const openCard = useCallback(
        async (summary: NoteSummary) => {
            if (summary.masked) {
                await revealPrivate();
                return;
            }
            await openEditor(summary);
        },
        [revealPrivate, openEditor]
    );

    const openArchives = useCallback(async () => {
        setActionError(null);
        const changed = await OpenPopup<boolean>(NOTE_ARCHIVE_POPUP);
        if (changed === true) {
            invalidate('notes.count');
            await reload();
        }
    }, [workspaceId, reload]);

    /**
     * The single primitive behind both drag & drop and the card's "Déplacer vers"
     * menu (which appends). The server takes the destination folder's full new
     * order; the previous folder simply keeps its own, one gap shorter.
     * Optimistic, with a rollback to the previous list on failure.
     *
     * Les notes projetées en sont exclues : elles se classent chez elles, et le
     * serveur refuse un ordre qui les inclut.
     */
    const dropInto = useCallback(
        async (dragged: NoteSummary, folderId: number | null, index: number) => {
            if (dragged.foreign) return;
            setActionError(null);
            const bucket = notes.filter((n) => n.folderId === folderId && !n.foreign).sort(byOrder);
            const from = bucket.findIndex((n) => n.id === dragged.id);
            const noteIds = bucket.map((n) => n.id);
            if (from !== -1) noteIds.splice(from, 1);
            // Pulling the note out of its own bucket shifts every later gap down.
            const at = Math.min(from !== -1 && from < index ? index - 1 : index, noteIds.length);
            noteIds.splice(at, 0, dragged.id);
            const unchanged = from !== -1 && noteIds.every((id, i) => id === bucket[i].id);
            if (unchanged) return;

            const previous = notes;
            setNotes((prev) =>
                prev.map((n) => {
                    const rank = noteIds.indexOf(n.id);
                    return rank === -1 ? n : { ...n, folderId, sortOrder: rank };
                })
            );
            try {
                await api.send('notes.reorder', { folderId, noteIds });
            } catch (e) {
                setNotes(previous);
                setActionError(humanizeError(e, 'Déplacement impossible.'));
            }
        },
        [notes, workspaceId]
    );

    /** Menu shortcut: send a note to the end of another folder. */
    const moveNote = useCallback(
        (summary: NoteSummary, folderId: number | null) => {
            if (folderId === summary.folderId) return;
            void dropInto(summary, folderId, Number.MAX_SAFE_INTEGER);
        },
        [dropInto]
    );

    const createFolder = useCallback(async () => {
        setActionError(null);
        const name = await OpenPopup<FolderNameResult>(FOLDER_NAME_POPUP, { name: '', mode: 'add' } as FolderNameInput);
        if (!name) return;
        try {
            const res = await api.send('notes.folderAdd', { name });
            setFolders((prev) => [...prev, res.folder]);
        } catch (e) {
            setActionError(humanizeError(e, 'Création du dossier impossible.'));
        }
    }, [workspaceId]);

    const renameFolder = useCallback(
        async (folder: NoteFolder) => {
            setActionError(null);
            const name = await OpenPopup<FolderNameResult>(FOLDER_NAME_POPUP, {
                name: folder.name,
                mode: 'rename'
            } as FolderNameInput);
            if (!name || name === folder.name) return;
            try {
                const res = await api.send('notes.folderRename', { folderId: folder.id, name });
                setFolders((prev) => prev.map((f) => (f.id === folder.id ? res.folder : f)));
            } catch (e) {
                setActionError(humanizeError(e, 'Renommage impossible.'));
            }
        },
        [workspaceId]
    );

    const deleteFolder = useCallback(
        async (folder: NoteFolder) => {
            setActionError(null);
            const ok = await OpenPopup<boolean>(NOTE_CONFIRM_POPUP, {
                title: 'Supprimer le dossier',
                message: `Supprimer « ${folderLabel(folder)} » ? Les notes qu'il contient seront conservées et déplacées dans « Sans dossier ».`,
                confirmLabel: 'Supprimer'
            } as ConfirmInput);
            if (ok !== true) return;
            try {
                await api.send('notes.folderDelete', { folderId: folder.id });
                setFolders((prev) => prev.filter((f) => f.id !== folder.id));
                setNotes((prev) => prev.map((n) => (n.folderId === folder.id ? { ...n, folderId: null } : n)));
            } catch (e) {
                setActionError(humanizeError(e, 'Suppression du dossier impossible.'));
            }
        },
        [workspaceId]
    );

    /**
     * A masked note keeps its own folder (the `folderId` column is in the clear),
     * but search skips it: its title and preview aren't known client-side while
     * the session is locked. Une note projetée arrive sans dossier, donc à la
     * racine.
     */
    const { byFolder, unfiled, total } = useMemo(() => {
        const lower = search.trim().toLowerCase();
        const folderName = (id: number | null) => folders.find((f) => f.id === id)?.name ?? '';
        const filtered = lower
            ? notes.filter(
                  (n) =>
                      !n.masked &&
                      (n.title.toLowerCase().includes(lower) ||
                          (n.preview ?? '').toLowerCase().includes(lower) ||
                          folderName(n.folderId).toLowerCase().includes(lower))
              )
            : notes;

        const byFolder = new Map<number, NoteSummary[]>();
        const unfiled: NoteSummary[] = [];
        for (const n of filtered) {
            if (n.folderId === null) unfiled.push(n);
            else {
                const bucket = byFolder.get(n.folderId);
                if (bucket) bucket.push(n);
                else byFolder.set(n.folderId, [n]);
            }
        }
        byFolder.forEach((arr) => arr.sort(byOrder));
        unfiled.sort(byOrder);
        return { byFolder, unfiled, total: filtered.length };
    }, [notes, folders, search]);

    const maskedCount = useMemo(() => notes.filter((n) => n.masked).length, [notes]);

    const sortedFolders = useMemo(
        () => [...folders].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id),
        [folders]
    );

    /** `dir` is -1 to move the folder up, +1 to move it down. */
    const reorderFolder = useCallback(
        async (folder: NoteFolder, dir: -1 | 1) => {
            setActionError(null);
            const ordered = [...folders].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
            const i = ordered.findIndex((f) => f.id === folder.id);
            const j = i + dir;
            if (i === -1 || j < 0 || j >= ordered.length) return;
            [ordered[i], ordered[j]] = [ordered[j], ordered[i]];
            const previous = folders;
            const renumbered = ordered.map((f, idx) => ({ ...f, sortOrder: idx }));
            setFolders(renumbered);
            try {
                const res = await api.send('notes.folderReorder', { folderIds: ordered.map((f) => f.id) });
                setFolders(res.folders);
            } catch (e) {
                setFolders(previous);
                setActionError(humanizeError(e, 'Réorganisation impossible.'));
            }
        },
        [folders, workspaceId]
    );

    const dropAt = useCallback(
        (folderId: number | null, index: number) => {
            const dragged = draggingRef.current;
            draggingRef.current = null;
            if (dragged) void dropInto(dragged, folderId, index);
        },
        [dropInto]
    );

    const searching = search.trim() !== '';

    const renderGrid = (items: NoteSummary[], folderId: number | null) => (
        <NoteGrid
            notes={items}
            folders={sortedFolders}
            folderId={folderId}
            reorderable={!searching}
            onOpen={(n) => void openCard(n)}
            onMove={moveNote}
            onAdd={() => void openEditor(null, folderId)}
            onDragStart={(n) => (draggingRef.current = n)}
            onDragEnd={() => (draggingRef.current = null)}
            onDropAt={dropAt}
        />
    );

    return (
        <div className={styles.container}>
            <header className={styles.header}>
                <div className={styles.headerText}>
                    <h2 className={styles.title}>Notes</h2>
                    <p className={styles.subtitle}>
                        {total} note{total !== 1 ? 's' : ''}
                    </p>
                </div>
                <div className={styles.headerActions}>
                    {maskedCount > 0 && (
                        <Button icon='unlock' variant='secondary' onClick={() => void revealPrivate()}>
                            Déchiffrer ({maskedCount})
                        </Button>
                    )}
                    <Button icon='folder-plus' onClick={() => void createFolder()}>
                        Nouveau dossier
                    </Button>
                </div>
            </header>

            <div className={styles.toolbar}>
                <div className={styles.searchBar}>
                    <TextInput
                        placeholder='Rechercher une note, un dossier…'
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                    />
                </div>
                <button
                    type='button'
                    className={`${styles.iconAction} ${styles.archiveBtn}`}
                    title='Archives'
                    aria-label='Ouvrir les archives'
                    onClick={() => void openArchives()}
                >
                    <span className={`icon ${styles.toggleIcon} icon-archive`} />
                </button>
            </div>

            {actionError && <div className={styles.errorBanner}>{actionError}</div>}

            {!loaded && (
                <div className={styles.grid}>
                    {Array.from({ length: 6 }).map((_, i) => (
                        <div key={i} className={styles.skeletonCard} />
                    ))}
                </div>
            )}

            {loaded &&
                sortedFolders.map((folder, idx) => {
                    const items = byFolder.get(folder.id) ?? [];
                    if (searching && items.length === 0) return null;
                    // A filtered list isn't the real order, so nothing is reorderable.
                    const canReorder = !searching;
                    return (
                        <section key={folder.id} className={styles.folderSection}>
                            <div className={styles.folderTitle}>
                                <span className={`icon ${styles.badge} icon-folder`} />
                                <span className={styles.folderName}>{folderLabel(folder)}</span>
                                <span className={styles.count}>{items.length}</span>
                                <span className={styles.folderActions}>
                                    {canReorder && (
                                        <>
                                            <button
                                                type='button'
                                                className={styles.iconAction}
                                                aria-label='Monter le dossier'
                                                title='Monter'
                                                disabled={idx === 0}
                                                onClick={() => void reorderFolder(folder, -1)}
                                            >
                                                <span
                                                    className={`icon ${styles.toggleIcon} ${styles.chevronUp} icon-chevron-down`}
                                                />
                                            </button>
                                            <button
                                                type='button'
                                                className={styles.iconAction}
                                                aria-label='Descendre le dossier'
                                                title='Descendre'
                                                disabled={idx === sortedFolders.length - 1}
                                                onClick={() => void reorderFolder(folder, 1)}
                                            >
                                                <span className={`icon ${styles.toggleIcon} icon-chevron-down`} />
                                            </button>
                                        </>
                                    )}
                                    <button
                                        type='button'
                                        className={styles.iconAction}
                                        aria-label='Renommer le dossier'
                                        title='Renommer'
                                        onClick={() => void renameFolder(folder)}
                                    >
                                        <span className={`icon ${styles.toggleIcon} icon-edit`} />
                                    </button>
                                    <button
                                        type='button'
                                        className={styles.iconAction}
                                        aria-label='Supprimer le dossier'
                                        title='Supprimer'
                                        onClick={() => void deleteFolder(folder)}
                                    >
                                        <span className={`icon ${styles.toggleIcon} icon-trash`} />
                                    </button>
                                </span>
                            </div>
                            {renderGrid(items, folder.id)}
                        </section>
                    );
                })}

            {loaded && (!searching || unfiled.length > 0) && (
                <section className={styles.folderSection}>
                    <div className={styles.folderTitle}>
                        <span className={styles.folderName}>Sans dossier</span>
                        <span className={styles.count}>{unfiled.length}</span>
                    </div>
                    {renderGrid(unfiled, null)}
                </section>
            )}

            {loaded && searching && total === 0 && (
                <div className={styles.empty}>
                    <span className={styles.emptyIcon}>📝</span>
                    <p>Aucun résultat</p>
                </div>
            )}

            <NoteEditor />
            <ArchivePopup />
            <FolderNamePopup />
            <ConfirmPopup />
        </div>
    );
}

function folderLabel(folder: NoteFolder): string {
    return folder.name || 'Dossier sans nom';
}

/** Optimistic summary after an add/edit, until the next re-list. */
function toSummary(note: Note): NoteSummary {
    const checks = note.blocks.filter((b) => b.type === 'check');
    const previewBlock = note.blocks.find((b) => 'text' in b && b.text.trim() !== '');
    const previewText = previewBlock && 'text' in previewBlock ? previewBlock.text.trim() : '';
    return {
        id: note.id,
        title: note.title,
        folderId: note.folderId,
        sortOrder: note.sortOrder,
        preview: previewText.slice(0, 140),
        checkTotal: checks.length,
        checkDone: checks.filter((b) => b.type === 'check' && b.done).length,
        private: note.private,
        masked: false,
        foreign: note.foreign,
        // The editor only ever round-trips active notes.
        archivedAt: null,
        updated: note.updated,
        created: note.created
    };
}

export default Notes;
