import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import styles from './style.module.css';

import NoteCard from './NoteCard';
import NoteEditor, {
    NOTE_EDITOR_POPUP,
    type NoteDraft,
    type NoteEditorInput,
    type NoteEditorResult
} from './NoteEditor';
import RevealPopup, { NOTE_REVEAL_POPUP } from './RevealPopup';
import FolderNamePopup, { FOLDER_NAME_POPUP, type FolderNameInput, type FolderNameResult } from './FolderNamePopup';
import ConfirmPopup, { NOTE_CONFIRM_POPUP, type ConfirmInput } from './ConfirmPopup';

import { OpenPopup } from '@/Components/Popup';
import { ws, WsError } from '@/api/ws';
import TextInput from '@/Components/TextInput';
import Button from '@/Components/Button';
import { ensureUnlocked as ensureSecrecyUnlocked, touchSecrecy } from '@/stores/secrecy';

import type { FeatureProps } from '@/Features/types';
import type { Note, NoteFolder, NoteSummary } from 'deveye-types';

/** Sentinel section keys for buckets without a real folder id. */
const UNFILED = '__unfiled__';

/**
 * Run a request and, if the password-encryption layer reports `locked`, open the
 * global unlock prompt and retry once. Mirrors the Password feature so every
 * encrypted call is resilient. This is the DEK gate — distinct from the hidden
 * notes "reveal" gate handled separately below.
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

function FeatureNotes({ workspace }: FeatureProps) {
    const [loaded, setLoaded] = useState(false);
    const [search, setSearch] = useState('');
    const [notes, setNotes] = useState<NoteSummary[]>([]);
    const [folders, setFolders] = useState<NoteFolder[]>([]);
    const [actionError, setActionError] = useState<string | null>(null);
    const [dragOverKey, setDragOverKey] = useState<string | null>(null);
    const reloadRef = useRef<Promise<void> | null>(null);
    const draggingRef = useRef<NoteSummary | null>(null);
    /** Whether the session has passed "root auth" to read hidden notes. */
    const revealedRef = useRef(false);

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
    }, [workspace.id]);

    useEffect(() => {
        revealedRef.current = false;
        setLoaded(false);
        setNotes([]);
        setFolders([]);
        setActionError(null);
        void reload();
    }, [reload]);

    /** Ensure hidden notes are unlocked this session; prompts if needed. */
    const ensureRevealed = useCallback(async (): Promise<boolean> => {
        if (revealedRef.current) return true;
        const ok = await OpenPopup<boolean>(NOTE_REVEAL_POPUP);
        if (ok === true) {
            revealedRef.current = true;
            await reload(); // refetch so masked notes come back in full
            return true;
        }
        return false;
    }, [reload]);

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
                    const res = await withSecrecy(() =>
                        ws.send('note.edit', { workspaceId: workspace.id, noteId: existing.id, note: draft })
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

            // Opening a hidden note (locked card or already-hidden note) requires
            // root auth first; creating a new note never does.
            if (summary && (summary.locked || summary.hidden) && !(await ensureRevealed())) return;

            let existing: Note | null = null;
            if (summary) {
                try {
                    const res = await withSecrecy(() =>
                        ws.send('note.get', { workspaceId: workspace.id, noteId: summary.id })
                    );
                    existing = res.note;
                } catch (e) {
                    if (e instanceof WsError && e.code === 'auth_required') {
                        if (!(await ensureRevealed())) return;
                        try {
                            const res = await ws.send('note.get', { workspaceId: workspace.id, noteId: summary.id });
                            existing = res.note;
                        } catch (e2) {
                            setActionError(humanizeError(e2, 'Impossible d’ouvrir la note.'));
                            return;
                        }
                    } else {
                        setActionError(humanizeError(e, 'Impossible d’ouvrir la note.'));
                        return;
                    }
                }
            }

            const input: NoteEditorInput = { note: existing, folderId: existing ? existing.folderId : targetFolderId };
            const result = await OpenPopup<NoteEditorResult>(NOTE_EDITOR_POPUP, input);
            if (result === null) return;

            if (result === 'delete' && existing) {
                const confirmed = await OpenPopup<boolean>(NOTE_CONFIRM_POPUP, {
                    title: 'Supprimer la note',
                    message: `Supprimer « ${existing.title || 'Sans titre'} » ? Cette action est irréversible.`,
                    confirmLabel: 'Supprimer'
                } as ConfirmInput);
                if (confirmed !== true) return;
                try {
                    await ws.send('note.delete', { workspaceId: workspace.id, noteId: existing.id });
                    setNotes((prev) => prev.filter((n) => n.id !== existing!.id));
                } catch (e) {
                    setActionError(humanizeError(e, 'Suppression impossible.'));
                }
                return;
            }

            // Creating a hidden note also requires authorization.
            if (typeof result === 'object' && result.hidden && !revealedRef.current && !(await ensureRevealed())) {
                return;
            }
            if (typeof result === 'object') await saveDraft(existing, result);
        },
        [ensureRevealed, workspace.id, saveDraft]
    );

    /** Relocate a note to another folder (menu or drag & drop). */
    const moveNote = useCallback(
        async (summary: NoteSummary, folderId: number | null) => {
            setActionError(null);
            if (folderId === summary.folderId) return;
            if (summary.hidden && !revealedRef.current && !(await ensureRevealed())) return;
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
        [ensureRevealed, workspace.id]
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

    /** Notes filtered by search and bucketed by folder id (locked bucket apart). */
    const { byFolder, unfiled, locked, total } = useMemo(() => {
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
        const locked: NoteSummary[] = [];
        for (const n of filtered) {
            if (n.locked) locked.push(n);
            else if (n.folderId === null) unfiled.push(n);
            else {
                const bucket = byFolder.get(n.folderId);
                if (bucket) bucket.push(n);
                else byFolder.set(n.folderId, [n]);
            }
        }
        const sortPinned = (a: NoteSummary, b: NoteSummary) => Number(b.pinned) - Number(a.pinned);
        byFolder.forEach((arr) => arr.sort(sortPinned));
        unfiled.sort(sortPinned);
        return { byFolder, unfiled, locked, total: filtered.length };
    }, [notes, folders, search]);

    // Folders sorted by name for a stable, alphabetical layout.
    const sortedFolders = useMemo(() => [...folders].sort((a, b) => a.name.localeCompare(b.name, 'fr')), [folders]);

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
                sortedFolders.map((folder) => {
                    const items = byFolder.get(folder.id) ?? [];
                    // While searching, hide folders with no matching notes to cut noise.
                    if (searching && items.length === 0) return null;
                    return (
                        <section key={folder.id} className={styles.folderSection}>
                            <div {...dropProps(String(folder.id), folder.id)}>
                                <span className={`icon ${styles.badge} icon-folder`} />
                                <span className={styles.folderName}>{folder.name}</span>
                                <span className={styles.count}>{items.length}</span>
                                <span className={styles.folderActions}>
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

            {loaded && locked.length > 0 && (
                <section className={styles.folderSection}>
                    <div className={styles.folderTitle}>
                        <span className={`icon ${styles.badge} icon-lock`} />
                        <span className={styles.folderName}>Masquées</span>
                        <span className={styles.count}>{locked.length}</span>
                    </div>
                    {renderGrid(locked)}
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
            <RevealPopup />
            <FolderNamePopup />
            <ConfirmPopup />
        </div>
    );
}

/** Build an optimistic summary from a full note (after add/edit). */
function toSummary(note: Note): NoteSummary {
    const checks = note.blocks.filter((b) => b.type === 'check');
    const previewBlock = note.blocks.find((b) => b.text.trim() !== '');
    return {
        id: note.id,
        title: note.title,
        folderId: note.folderId,
        pinned: note.pinned,
        hidden: note.hidden,
        preview: previewBlock ? previewBlock.text.trim().slice(0, 140) : '',
        checkTotal: checks.length,
        checkDone: checks.filter((b) => b.type === 'check' && b.done).length,
        locked: false,
        updated: note.updated,
        created: note.created
    };
}

export default FeatureNotes;
