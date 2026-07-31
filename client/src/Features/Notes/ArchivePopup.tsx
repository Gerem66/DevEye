import { useCallback, useRef, useState } from 'react';

import styles from './style.module.css';

import Popup, { ClosePopup, OpenPopup } from '@/Components/Popup';
import Button from '@/Components/Button';
import { ws } from '@/api/ws';
import { humanizeError, withSecrecy } from './api';
import { stripInline } from './markdown';
import { NOTE_CONFIRM_POPUP, type ConfirmInput } from './ConfirmPopup';

import type { NoteSummary } from 'deveye-types';

export const NOTE_ARCHIVE_POPUP = 'popup-note-archives';

export interface ArchiveInput {
    workspaceId: number;
}

/** Full date + time of an archiving, epoch seconds. */
function formatArchivedAt(time: number): string {
    return new Date(time * 1000).toLocaleDateString('fr-FR', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

/**
 * The archive: notes removed from the main list but not destroyed. Each row can
 * be restored or, only from here, deleted for good — the two-step the server
 * enforces (`note.delete` refuses an active note).
 *
 * Owns its own fetch rather than receiving the list, so the archive stays a
 * self-contained view. Resolves OpenPopup with `true` when anything changed, so
 * the caller knows whether to re-list.
 */
export default function ArchivePopup() {
    const [workspaceId, setWorkspaceId] = useState(0);
    const [notes, setNotes] = useState<NoteSummary[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // Whether a restore/delete happened, so the caller re-lists on close.
    const changed = useRef(false);

    const load = useCallback(async (wsId: number) => {
        setLoaded(false);
        try {
            const res = await withSecrecy(() => ws.send('note.list', { workspaceId: wsId, archived: true }));
            setNotes(res.notes);
        } catch (e) {
            setNotes([]);
            setError(humanizeError(e, 'Impossible de charger les archives.'));
        } finally {
            setLoaded(true);
        }
    }, []);

    function handleOpen(input: ArchiveInput | null) {
        if (!input) return;
        changed.current = false;
        setError(null);
        setNotes([]);
        setWorkspaceId(input.workspaceId);
        void load(input.workspaceId);
    }

    function close() {
        ClosePopup(NOTE_ARCHIVE_POPUP, changed.current);
    }

    /** Drop the row locally after a successful mutation and flag the change. */
    function forget(noteId: number) {
        changed.current = true;
        setNotes((prev) => prev.filter((n) => n.id !== noteId));
    }

    async function restore(note: NoteSummary) {
        setError(null);
        try {
            await withSecrecy(() => ws.send('note.restore', { workspaceId, noteId: note.id }));
            forget(note.id);
        } catch (e) {
            setError(humanizeError(e, 'Restauration impossible.'));
        }
    }

    async function destroy(note: NoteSummary) {
        setError(null);
        const ok = await OpenPopup<boolean>(NOTE_CONFIRM_POPUP, {
            title: 'Supprimer définitivement',
            message: `Supprimer « ${noteLabel(note)} » pour de bon ? Cette action est irréversible.`,
            confirmLabel: 'Supprimer'
        } as ConfirmInput);
        if (ok !== true) return;
        try {
            await withSecrecy(() => ws.send('note.delete', { workspaceId, noteId: note.id }));
            forget(note.id);
        } catch (e) {
            setError(humanizeError(e, 'Suppression impossible.'));
        }
    }

    return (
        <Popup<ArchiveInput | null>
            id={NOTE_ARCHIVE_POPUP}
            title='Archives'
            width={560}
            autoFocus={false}
            holdSecrecy
            onInputChange={handleOpen}
            onClosePopup={close}
        >
            <p className={styles.popupHint}>
                Les notes supprimées atterrissent ici. Elles n’apparaissent plus dans la liste et ne sont perdues que si
                vous les supprimez définitivement.
            </p>

            {error && <div className={styles.errorBanner}>{error}</div>}

            {loaded && notes.length === 0 && !error && <p className={styles.archiveEmpty}>Aucune note archivée.</p>}

            <ul className={styles.archiveList}>
                {notes.map((note) => (
                    <li key={note.id} className={styles.archiveRow}>
                        <div className={styles.archiveText}>
                            <span className={styles.archiveTitle}>
                                {note.masked && <span className={`icon ${styles.badge} icon-lock`} />}
                                {noteLabel(note)}
                            </span>
                            {note.preview && <span className={styles.archivePreview}>{stripInline(note.preview)}</span>}
                            {note.archivedAt !== null && (
                                <span className={styles.archiveDate}>
                                    Archivée le {formatArchivedAt(note.archivedAt)}
                                </span>
                            )}
                        </div>
                        <div className={styles.archiveActions}>
                            <button
                                type='button'
                                className={styles.iconAction}
                                title='Restaurer'
                                aria-label='Restaurer la note'
                                onClick={() => void restore(note)}
                            >
                                <span className={`icon ${styles.toggleIcon} icon-restart`} />
                            </button>
                            <button
                                type='button'
                                className={`${styles.iconAction} ${styles.iconActionDanger}`}
                                title='Supprimer définitivement'
                                aria-label='Supprimer définitivement la note'
                                onClick={() => void destroy(note)}
                            >
                                <span className={`icon ${styles.toggleIcon} icon-trash`} />
                            </button>
                        </div>
                    </li>
                ))}
            </ul>

            <div className={styles.editorFooter} style={{ marginTop: 'var(--space-md)' }}>
                <span />
                <div className={styles.footerRight}>
                    <Button variant='secondary' onClick={close}>
                        Fermer
                    </Button>
                </div>
            </div>
        </Popup>
    );
}

/** What to show for a row: a masked note never handed over its title. */
function noteLabel(note: NoteSummary): string {
    if (note.masked) return 'Note privée';
    return note.title || 'Sans titre';
}
