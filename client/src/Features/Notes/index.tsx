import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import styles from './style.module.css';

import NoteCard from './NoteCard';
import NoteEditor, {
    NOTE_EDITOR_POPUP,
    type NoteDraft,
    type NoteEditorInput,
    type NoteEditorResult
} from './NoteEditor';
import LockPopup, { NOTE_LOCK_POPUP, type NoteLockInput, type LockVerifyResult } from './LockPopup';
import LockSetPopup from './LockSetPopup';
import LockManagePopup from './LockManagePopup';
import FolderNamePopup, { FOLDER_NAME_POPUP, type FolderNameInput, type FolderNameResult } from './FolderNamePopup';
import ConfirmPopup, { NOTE_CONFIRM_POPUP, type ConfirmInput } from './ConfirmPopup';

import { OpenPopup } from '@/Components/Popup';
import { ws, WsError } from '@/api/ws';
import TextInput from '@/Components/TextInput';
import Button from '@/Components/Button';
import { ensureUnlocked as ensureSecrecyUnlocked, touchSecrecy, UnlockCancelledError } from '@/stores/secrecy';

import type { FeatureProps } from '@/Features/types';
import type { Note, NoteFolder, NoteSummary } from 'deveye-types';

/** Sentinel section keys for buckets without a real folder id. */
const UNFILED = '__unfiled__';

/**
 * Run a request and, if the password-encryption layer reports `locked`, open the
 * global unlock prompt and retry once. Mirrors the Password feature so every
 * encrypted call is resilient. This is the DEK gate (password-encryption layer)
 * — distinct from a note's per-note lock, handled separately on open.
 */
async function withSecrecy<T>(run: () => Promise<T>): Promise<T> {
    try {
        const out = await run();
        touchSecrecy();
        return out;
    } catch (e) {
        if (e instanceof WsError && e.code === 'locked') {
            await ensureSecrecyUnlocked();
            const out = await run();
            touchSecrecy();
            return out;
        }
        throw e;
    }
}

function humanizeError(e: unknown, fallback: string): string {
    if (e instanceof WsError) {
        if (e.code === 'auth_required' || e.code === 'locked') return 'Déverrouillage requis.';
        if (e.code === 'auth_invalid') return 'Mot de passe principal incorrect.';
        if (e.code === 'forbidden') return 'Accès refusé.';
    }
    return fallback;
}

function FeatureNotes({ workspace, closeFeature }: FeatureProps) {
    const [loaded, setLoaded] = useState(false);
    const [search, setSearch] = useState('');
    const [notes, setNotes] = useState<NoteSummary[]>([]);
    const [folders, setFolders] = useState<NoteFolder[]>([]);
    const [actionError, setActionError] = useState<string | null>(null);
    const [dragOverKey, setDragOverKey] = useState<string | null>(null);
    const reloadRef = useRef<Promise<void> | null>(null);
    const draggingRef = useRef<NoteSummary | null>(null);
    // Read at call time so the load effect never depends on this changing prop.
    const closeFeatureRef = useRef(closeFeature);
    closeFeatureRef.current = closeFeature;

    const reload = useCallback(async () => {
        if (reloadRef.current) return reloadRef.current;
        const task = (async () => {
            try {
                const [notesRes, foldersRes] = await Promise.all([
                    withSecrecy(() => ws.send('note.list', { workspaceId: workspace.id })),
                    withSecrecy(() => ws.send('folder.list', { workspaceId: workspace.id }))
                ]);
                setNotes(notesRes.notes);
                setFolders(foldersRes.folders);
            } catch (e) {
                setNotes([]);
                setFolders([]);
                // Nothing to show without the password: close instead of leaving
                // an empty, unusable view behind.
                if (e instanceof UnlockCancelledError) closeFeatureRef.current();
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
    }, [workspace.id]);

    useEffect(() => {
        setLoaded(false);
        setNotes([]);
        setFolders([]);
        setActionError(null);
        void reload();
    }, [reload]);

    /**
     * Prompt for a locked note's dedicated password and `note.get` it, retrying
     * on a wrong password. Returns the full note plus the password that opened it
     * (so a later edit/delete in this same flow can reuse it), or null if the
     * user cancels. The password is verified server-side on every open.
     */
    const openLockedNote = useCallback(
        async (noteId: number): Promise<{ note: Note; password: string } | null> => {
            // The popup owns the retry loop: it calls `verify` and stays open with
            // an inline error on a wrong password (no close/reopen flicker). On the
            // first valid password we capture the note here and resolve.
            let opened: Note | null = null;
            const verify = async (password: string): Promise<LockVerifyResult> => {
                try {
                    const res = await withSecrecy(() =>
                        ws.send('note.get', { workspaceId: workspace.id, noteId, password })
                    );
                    opened = res.note;
                    return { ok: true };
                } catch (e) {
                    if (e instanceof WsError && (e.code === 'auth_invalid' || e.code === 'auth_required')) {
                        return { ok: false };
                    }
                    setActionError(humanizeError(e, 'Impossible d’ouvrir la note.'));
                    return { ok: false, abort: true };
                }
            };
            const password = await OpenPopup<string>(NOTE_LOCK_POPUP, { intent: 'open', verify } as NoteLockInput);
            if (password === null || opened === null) return null;
            return { note: opened, password };
        },
        [workspace.id]
    );

    const upsert = useCallback((note: Note) => {
        // A note that is now locked renders as a masked card (padlock, no title
        // or preview) exactly as the list would return it on reload.
        const summary = note.locked ? toLockedSummary(note) : toSummary(note);
        setNotes((prev) => {
            const exists = prev.some((n) => n.id === summary.id);
            return exists ? prev.map((n) => (n.id === summary.id ? summary : n)) : [summary, ...prev];
        });
    }, []);

    const saveDraft = useCallback(
        async (existing: Note | null, draft: NoteDraft, password?: string) => {
            try {
                if (existing) {
                    const res = await withSecrecy(() =>
                        ws.send('note.edit', { workspaceId: workspace.id, noteId: existing.id, note: draft, password })
                    );
                    upsert(res.note);
                } else {
                    const res = await withSecrecy(() =>
                        ws.send('note.add', { workspaceId: workspace.id, note: draft })
                    );
                    upsert(res.note);
                }
            } catch (e) {
                setActionError(humanizeError(e, 'Enregistrement impossible.'));
            }
        },
        [workspace.id, upsert]
    );

    /** Open the editor to create a note (optionally pre-filed) or edit one. */
    const openEditor = useCallback(
        async (summary: NoteSummary | null, targetFolderId: number | null = null) => {
            setActionError(null);

            let existing: Note | null = null;
            // Password that opened a locked note — reused for its edit/delete so
            // the user isn't prompted twice within the same editor session.
            let unlockPassword: string | undefined;
            if (summary) {
                if (summary.locked) {
                    const opened = await openLockedNote(summary.id);
                    if (!opened) return;
                    existing = opened.note;
                    unlockPassword = opened.password;
                } else {
                    try {
                        const res = await withSecrecy(() =>
                            ws.send('note.get', { workspaceId: workspace.id, noteId: summary.id })
                        );
                        existing = res.note;
                    } catch (e) {
                        setActionError(humanizeError(e, 'Impossible d’ouvrir la note.'));
                        return;
                    }
                }
            }

            const input: NoteEditorInput = { note: existing, folderId: existing ? existing.folderId : targetFolderId };
            const result = await OpenPopup<NoteEditorResult>(NOTE_EDITOR_POPUP, input);
            if (result === null) return;

            // Deletion is already confirmed inside the editor (popup over it), so
            // 'delete' here means "go ahead".
            if (result === 'delete' && existing) {
                try {
                    await ws.send('note.delete', {
                        workspaceId: workspace.id,
                        noteId: existing.id,
                        password: unlockPassword
                    });
                    setNotes((prev) => prev.filter((n) => n.id !== existing!.id));
                } catch (e) {
                    setActionError(humanizeError(e, 'Suppression impossible.'));
                }
                return;
            }

            if (typeof result === 'object') await saveDraft(existing, result, unlockPassword);
        },
        [openLockedNote, workspace.id, saveDraft]
    );

    /** Relocate a note to another folder (menu or drag & drop). */
    const moveNote = useCallback(
        async (summary: NoteSummary, folderId: number | null) => {
            setActionError(null);
            if (folderId === summary.folderId) return;
            // Moving is benign and never exposes the body, so even a locked note
            // can be re-filed without its password (matches the server gate).
            // Optimistic: re-bucket immediately, roll back on failure.
            setNotes((prev) => prev.map((n) => (n.id === summary.id ? { ...n, folderId } : n)));
            try {
                await withSecrecy(() =>
                    ws.send('note.move', { workspaceId: workspace.id, noteId: summary.id, folderId })
                );
            } catch (e) {
                setNotes((prev) => prev.map((n) => (n.id === summary.id ? { ...n, folderId: summary.folderId } : n)));
                setActionError(humanizeError(e, 'Déplacement impossible.'));
            }
        },
        [workspace.id]
    );

    const createFolder = useCallback(async () => {
        setActionError(null);
        const name = await OpenPopup<FolderNameResult>(FOLDER_NAME_POPUP, { name: '', mode: 'add' } as FolderNameInput);
        if (!name) return;
        try {
            const res = await withSecrecy(() => ws.send('folder.add', { workspaceId: workspace.id, name }));
            setFolders((prev) => [...prev, res.folder]);
        } catch (e) {
            setActionError(humanizeError(e, 'Création du dossier impossible.'));
        }
    }, [workspace.id]);

    const renameFolder = useCallback(
        async (folder: NoteFolder) => {
            setActionError(null);
            const name = await OpenPopup<FolderNameResult>(FOLDER_NAME_POPUP, {
                name: folder.name,
                mode: 'rename'
            } as FolderNameInput);
            if (!name || name === folder.name) return;
            try {
                const res = await withSecrecy(() =>
                    ws.send('folder.rename', { workspaceId: workspace.id, folderId: folder.id, name })
                );
                setFolders((prev) => prev.map((f) => (f.id === folder.id ? res.folder : f)));
            } catch (e) {
                setActionError(humanizeError(e, 'Renommage impossible.'));
            }
        },
        [workspace.id]
    );

    const deleteFolder = useCallback(
        async (folder: NoteFolder) => {
            setActionError(null);
            const ok = await OpenPopup<boolean>(NOTE_CONFIRM_POPUP, {
                title: 'Supprimer le dossier',
                message: `Supprimer « ${folder.name} » ? Les notes qu'il contient seront conservées et déplacées dans « Sans dossier ».`,
                confirmLabel: 'Supprimer'
            } as ConfirmInput);
            if (ok !== true) return;
            try {
                await withSecrecy(() => ws.send('folder.delete', { workspaceId: workspace.id, folderId: folder.id }));
                setFolders((prev) => prev.filter((f) => f.id !== folder.id));
                setNotes((prev) => prev.map((n) => (n.folderId === folder.id ? { ...n, folderId: null } : n)));
            } catch (e) {
                setActionError(humanizeError(e, 'Suppression du dossier impossible.'));
            }
        },
        [workspace.id]
    );

    /**
     * Notes filtered by search and bucketed by folder id. Locked notes are just
     * regular notes whose body is masked — they stay in their own folder (the
     * clear `folderId` column), never pulled into a special section. Search skips
     * locked notes since their title/preview aren't available client-side.
     */
    const { byFolder, unfiled, total } = useMemo(() => {
        const lower = search.trim().toLowerCase();
        const folderName = (id: number | null) => folders.find((f) => f.id === id)?.name ?? '';
        const filtered = lower
            ? notes.filter(
                  (n) =>
                      !n.locked &&
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
        const sortPinned = (a: NoteSummary, b: NoteSummary) => Number(b.pinned) - Number(a.pinned);
        byFolder.forEach((arr) => arr.sort(sortPinned));
        unfiled.sort(sortPinned);
        return { byFolder, unfiled, total: filtered.length };
    }, [notes, folders, search]);

    // Folders in their manual order (sortOrder); the user moves them up/down.
    const sortedFolders = useMemo(
        () => [...folders].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id),
        [folders]
    );

    /** Move a folder one slot up (dir -1) or down (dir +1); persists the new order. */
    const reorderFolder = useCallback(
        async (folder: NoteFolder, dir: -1 | 1) => {
            setActionError(null);
            const ordered = [...folders].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
            const i = ordered.findIndex((f) => f.id === folder.id);
            const j = i + dir;
            if (i === -1 || j < 0 || j >= ordered.length) return;
            [ordered[i], ordered[j]] = [ordered[j], ordered[i]];
            // Optimistic: renumber locally, roll back to the previous list on failure.
            const previous = folders;
            const renumbered = ordered.map((f, idx) => ({ ...f, sortOrder: idx }));
            setFolders(renumbered);
            try {
                const res = await withSecrecy(() =>
                    ws.send('folder.reorder', {
                        workspaceId: workspace.id,
                        folderIds: ordered.map((f) => f.id)
                    })
                );
                setFolders(res.folders);
            } catch (e) {
                setFolders(previous);
                setActionError(humanizeError(e, 'Réorganisation impossible.'));
            }
        },
        [folders, workspace.id]
    );

    const onDropTo = useCallback(
        (folderId: number | null) => {
            const dragged = draggingRef.current;
            draggingRef.current = null;
            setDragOverKey(null);
            if (dragged) void moveNote(dragged, folderId);
        },
        [moveNote]
    );

    const renderGrid = (items: NoteSummary[]) => (
        <div className={styles.grid}>
            {items.map((note) => (
                <NoteCard
                    key={note.id}
                    note={note}
                    folders={sortedFolders}
                    onOpen={(n) => void openEditor(n)}
                    onMove={(n, fid) => void moveNote(n, fid)}
                    onDragStart={(n) => (draggingRef.current = n)}
                    onDragEnd={() => {
                        draggingRef.current = null;
                        setDragOverKey(null);
                    }}
                />
            ))}
        </div>
    );

    /** Drop-target props shared by folder / unfiled headers. */
    const dropProps = (key: string, folderId: number | null) => ({
        className: `${styles.folderTitle} ${dragOverKey === key ? styles.folderTitleDrop : ''}`,
        onDragOver: (e: React.DragEvent) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            setDragOverKey(key);
        },
        onDragLeave: () => setDragOverKey((k) => (k === key ? null : k)),
        onDrop: (e: React.DragEvent) => {
            e.preventDefault();
            onDropTo(folderId);
        }
    });

    const searching = search.trim() !== '';

    return (
        <div className={styles.container}>
            <header className={styles.header}>
                <div className={styles.headerText}>
                    <h2 className={styles.title}>Notes</h2>
                    <p className={styles.subtitle}>
                        {total} note{total !== 1 ? 's' : ''}
                    </p>
                </div>
                <Button icon='folder-plus' onClick={() => void createFolder()}>
                    Nouveau dossier
                </Button>
            </header>

            <div className={styles.toolbar}>
                <div className={styles.searchBar}>
                    <TextInput
                        placeholder='Rechercher une note, un dossier…'
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                    />
                </div>
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
                    // While searching, hide folders with no matching notes to cut noise.
                    if (searching && items.length === 0) return null;
                    // Reordering is meaningless while searching (the list is filtered).
                    const canReorder = !searching;
                    return (
                        <section key={folder.id} className={styles.folderSection}>
                            <div {...dropProps(String(folder.id), folder.id)}>
                                <span className={`icon ${styles.badge} icon-folder`} />
                                <span className={styles.folderName}>{folder.name}</span>
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
                                        aria-label='Ajouter une note'
                                        title='Ajouter une note ici'
                                        onClick={() => void openEditor(null, folder.id)}
                                    >
                                        <span className={`icon ${styles.toggleIcon} icon-add`} />
                                    </button>
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
                            {items.length > 0 ? (
                                renderGrid(items)
                            ) : (
                                <p className={styles.folderEmpty}>Dossier vide — ajoutez une note avec « + ».</p>
                            )}
                        </section>
                    );
                })}

            {loaded && unfiled.length > 0 && (
                <section className={styles.folderSection}>
                    <div {...dropProps(UNFILED, null)}>
                        <span className={styles.folderName}>Sans dossier</span>
                        <span className={styles.count}>{unfiled.length}</span>
                        <span className={styles.folderActions}>
                            <button
                                type='button'
                                className={styles.iconAction}
                                aria-label='Ajouter une note'
                                title='Ajouter une note'
                                onClick={() => void openEditor(null, null)}
                            >
                                <span className={`icon ${styles.toggleIcon} icon-add`} />
                            </button>
                        </span>
                    </div>
                    {renderGrid(unfiled)}
                </section>
            )}

            {loaded && total === 0 && (
                <div className={styles.empty}>
                    <span className={styles.emptyIcon}>📝</span>
                    <p>{searching ? 'Aucun résultat' : 'Aucune note pour le moment'}</p>
                    {!searching && (
                        <Button icon='add' variant='secondary' onClick={() => void openEditor(null, null)}>
                            Créer une note
                        </Button>
                    )}
                </div>
            )}

            <NoteEditor />
            <LockPopup />
            <LockSetPopup />
            <LockManagePopup />
            <FolderNamePopup />
            <ConfirmPopup />
        </div>
    );
}

/** Build a masked summary for a (now) locked note — padlock card, no body. */
function toLockedSummary(note: Note): NoteSummary {
    return {
        id: note.id,
        title: '',
        folderId: note.folderId,
        pinned: note.pinned,
        checkTotal: 0,
        checkDone: 0,
        locked: true,
        updated: note.updated,
        created: note.created
    };
}

/** Build an optimistic summary from a full (open) note after add/edit. */
function toSummary(note: Note): NoteSummary {
    const checks = note.blocks.filter((b) => b.type === 'check');
    const previewBlock = note.blocks.find((b) => b.text.trim() !== '');
    return {
        id: note.id,
        title: note.title,
        folderId: note.folderId,
        pinned: note.pinned,
        preview: previewBlock ? previewBlock.text.trim().slice(0, 140) : '',
        checkTotal: checks.length,
        checkDone: checks.filter((b) => b.type === 'check' && b.done).length,
        locked: false,
        updated: note.updated,
        created: note.created
    };
}

export default FeatureNotes;
