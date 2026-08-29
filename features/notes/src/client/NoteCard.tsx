import { useEffect, useRef, useState } from 'react';

import styles from './style.module.css';
import { stripInline } from './markdown';

import type { NoteFolder, NoteSummary } from '../contracts/domain';
import { StatusBadge, useLiveOutline } from 'deveye-sdk-client';

function formatCardDate(time: number, full = false): string {
    return new Date(time * 1000).toLocaleDateString(
        'fr-FR',
        full
            ? { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }
            : { day: '2-digit', month: '2-digit', year: '2-digit' }
    );
}

interface NoteCardProps {
    note: NoteSummary;
    folders: NoteFolder[];
    /** Off while searching, where the filtered grid isn't the real order. */
    draggable: boolean;
    onOpen: (note: NoteSummary) => void;
    onMove: (note: NoteSummary, folderId: number | null) => void;
    onDragStart: (note: NoteSummary) => void;
    onDragEnd: () => void;
}

/**
 * A `masked` note (private, session still locked) shows only a padlock: no title
 * or body ever reached the client. Cards are drag sources only, the surrounding
 * {@link NoteGrid} owns the drop side; masked ones drag too, since positioning
 * never touches the body. Une note projetée depuis un autre espace n'a ni le menu
 * ni le glisser : son rang est celui de son domicile, et le serveur refuse de la
 * classer d'ici.
 */
export default function NoteCard({ note, folders, draggable, onOpen, onMove, onDragStart, onDragEnd }: NoteCardProps) {
    const [menuOpen, setMenuOpen] = useState(false);
    const menuRef = useRef<HTMLDivElement | null>(null);
    // La couleur de qui édite la note en ce moment.
    const outline = useLiveOutline('l1', String(note.id));

    useEffect(() => {
        if (!menuOpen) return;
        const onDocClick = (e: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
        };
        document.addEventListener('mousedown', onDocClick);
        return () => document.removeEventListener('mousedown', onDocClick);
    }, [menuOpen]);

    // Shared by both renderings so a masked card drags exactly like a readable
    // one; `data-note-card` is how the grid locates the cards to measure.
    const dnd = {
        draggable,
        'data-note-card': '',
        ...outline,
        onDragStart: (e: React.DragEvent) => {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', String(note.id));
            onDragStart(note);
        },
        onDragEnd
    };

    if (note.masked) {
        return (
            <button
                type='button'
                className={`${styles.card} ${styles.cardMasked}`}
                onClick={() => onOpen(note)}
                aria-label='Note privée, déchiffrer'
                {...dnd}
            >
                <span className={`icon ${styles.maskedIcon} icon-lock`} />
                <span className={styles.maskedLabel}>Note privée</span>
            </button>
        );
    }

    const hasChecks = note.checkTotal > 0;
    const updatedLabel = formatCardDate(note.updated);

    function move(folderId: number | null) {
        setMenuOpen(false);
        if (folderId !== note.folderId) onMove(note, folderId);
    }

    return (
        <div
            className={styles.card}
            role='button'
            tabIndex={0}
            {...dnd}
            onClick={() => onOpen(note)}
            onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onOpen(note);
                }
            }}
        >
            <div className={styles.cardHead}>
                <h4 className={styles.cardTitle}>{note.title || 'Sans titre'}</h4>
                <span className={styles.cardBadges}>
                    {note.foreign && (
                        <span title='Cette note appartient à un autre espace qui la partage ici'>
                            <StatusBadge tone='accent'>partagée</StatusBadge>
                        </span>
                    )}
                    {note.private && <span className={`icon ${styles.badge} icon-lock`} aria-label='Privée' />}
                    {!note.foreign && (
                        <div className={`${styles.cardMenu} ${menuOpen ? styles.menuOpen : ''}`} ref={menuRef}>
                            <button
                                type='button'
                                className={styles.cardMenuBtn}
                                aria-label='Options de la note'
                                title='Déplacer…'
                                onClick={(e) => {
                                    e.stopPropagation();
                                    setMenuOpen((v) => !v);
                                }}
                            >
                                <span className={`icon ${styles.badge} icon-folder`} />
                            </button>
                            {menuOpen && (
                                <div className={styles.menu} onClick={(e) => e.stopPropagation()}>
                                    <div className={styles.menuLabel}>Déplacer vers</div>
                                    <button
                                        type='button'
                                        className={`${styles.menuItem} ${note.folderId === null ? styles.menuItemActive : ''}`}
                                        onClick={() => move(null)}
                                    >
                                        Sans dossier
                                    </button>
                                    {folders.map((f) => (
                                        <button
                                            key={f.id}
                                            type='button'
                                            className={`${styles.menuItem} ${
                                                note.folderId === f.id ? styles.menuItemActive : ''
                                            }`}
                                            onClick={() => move(f.id)}
                                        >
                                            {f.name}
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}
                </span>
            </div>

            {note.preview && <p className={styles.cardPreview}>{stripInline(note.preview)}</p>}

            <div className={styles.cardMeta}>
                {hasChecks && (
                    <span className={styles.checkProgress}>
                        <span
                            className={`icon ${styles.badge} icon-${
                                note.checkDone === note.checkTotal ? 'square-check' : 'square-empty'
                            }`}
                        />
                        {note.checkDone}/{note.checkTotal}
                    </span>
                )}
                <span
                    className={styles.cardDate}
                    title={`Dernière modification : ${formatCardDate(note.updated, true)}`}
                >
                    {updatedLabel}
                </span>
            </div>
        </div>
    );
}
