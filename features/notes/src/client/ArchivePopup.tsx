import { useCallback, useRef, useState } from 'react';

import styles from './style.module.css';

import { Button, ClosePopup, humanizeError, OpenPopup, Popup, StatusBadge, withSecrecy } from 'deveye-sdk-client';
import { api } from './api';
import { stripInline } from './markdown';
import { NOTE_CONFIRM_POPUP, type ConfirmInput } from './ConfirmPopup';

import type { NoteSummary } from '../contracts/domain';

export const NOTE_ARCHIVE_POPUP = 'popup-note-archives';

/** `time` is in epoch seconds. */
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
 * Deleting for good is only offered here: `notes.delete` refuses an active note.
 * Une note projetée depuis un autre espace se restaure d'ici, mais ne s'y détruit
 * pas : le serveur le refuse. Resolves with `true` when something changed, so the
 * caller knows whether to re-list.
 */
export default function ArchivePopup() {
    const [notes, setNotes] = useState<NoteSummary[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const changed = useRef(false);

    const load = useCallback(async () => {
        setLoaded(false);
        try {
            const res = await withSecrecy(() => api.send('notes.list', { archived: true }));
            setNotes(res.notes);
        } catch (e) {
            setNotes([]);
            setError(humanizeError(e, 'Impossible de charger les archives.'));
        } finally {
            setLoaded(true);
        }
    }, []);

    function handleOpen() {
        changed.current = false;
        setError(null);
        setNotes([]);
        void load();
    }

    function close() {
        ClosePopup(NOTE_ARCHIVE_POPUP, changed.current);
    }

    function forget(noteId: number) {
        changed.current = true;
        setNotes((prev) => prev.filter((n) => n.id !== noteId));
    }

    async function restore(note: NoteSummary) {
        setError(null);
        try {
            await withSecrecy(() => api.send('notes.restore', { noteId: note.id }));
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
            await withSecrecy(() => api.send('notes.delete', { noteId: note.id }));
            forget(note.id);
        } catch (e) {
            setError(humanizeError(e, 'Suppression impossible.'));
        }
    }

    return (
        <Popup
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
                                {note.foreign && (
                                    <span title='Cette note appartient à un autre espace qui la partage ici'>
                                        <StatusBadge tone='accent'>partagée</StatusBadge>
                                    </span>
                                )}
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
                            {!note.foreign && (
                                <button
                                    type='button'
                                    className={`${styles.iconAction} ${styles.iconActionDanger}`}
                                    title='Supprimer définitivement'
                                    aria-label='Supprimer définitivement la note'
                                    onClick={() => void destroy(note)}
                                >
                                    <span className={`icon ${styles.toggleIcon} icon-trash`} />
                                </button>
                            )}
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

/** A masked note never handed over its title. */
function noteLabel(note: NoteSummary): string {
    if (note.masked) return 'Note privée';
    return note.title || 'Sans titre';
}
