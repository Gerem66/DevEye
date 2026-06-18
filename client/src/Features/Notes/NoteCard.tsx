import { useEffect, useRef, useState } from 'react';

import styles from './style.module.css';

import type { NoteFolder, NoteSummary } from 'deveye-types';

interface NoteCardProps {
    note: NoteSummary;
    folders: NoteFolder[];
    onOpen: (note: NoteSummary) => void;
    onMove: (note: NoteSummary, folderId: number | null) => void;
    onDragStart: (note: NoteSummary) => void;
    onDragEnd: () => void;
}

/**
 * A single note preview. A `locked` hidden note shows only a placeholder (no
 * body ever reached the client); clicking it triggers the reveal flow. Readable
 * cards are draggable (to a folder header) and expose a discreet "⋯" menu to
 * move the note between folders without opening the editor.
 */
export default function NoteCard({ note, folders, onOpen, onMove, onDragStart, onDragEnd }: NoteCardProps) {
    const [menuOpen, setMenuOpen] = useState(false);
    const menuRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        if (!menuOpen) return;
        const onDocClick = (e: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
        };
        document.addEventListener('mousedown', onDocClick);
        return () => document.removeEventListener('mousedown', onDocClick);
    }, [menuOpen]);

    if (note.locked) {
        return (
            <button
                type='button'
                className={`${styles.card} ${styles.cardLocked}`}
                onClick={() => onOpen(note)}
                aria-label='Note masquée — déverrouiller'
            >
                <span className={styles.lockedHint}>
                    <span className={`icon ${styles.badge} icon-lock`} />
                    Note masquée
                </span>
            </button>
        );
    }

    const hasChecks = note.checkTotal > 0;

    function move(folderId: number | null) {
        setMenuOpen(false);
        if (folderId !== note.folderId) onMove(note, folderId);
    }

    return (
        <div
            className={styles.card}
            role='button'
            tabIndex={0}
            draggable
            onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', String(note.id));
                onDragStart(note);
            }}
            onDragEnd={onDragEnd}
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
                    {note.hidden && <span className={`icon ${styles.badge} icon-lock`} aria-label='Masquée' />}
                    {note.pinned && <span className={`icon ${styles.badge} icon-star`} aria-label='Épinglée' />}
                    <div className={styles.cardMenu} ref={menuRef}>
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
                </span>
            </div>

            {note.preview && <p className={styles.cardPreview}>{note.preview}</p>}

            {hasChecks && (
                <div className={styles.cardMeta}>
                    <span className={styles.checkProgress}>
                        <span
                            className={`icon ${styles.badge} icon-${
                                note.checkDone === note.checkTotal ? 'square-check' : 'square-empty'
                            }`}
                        />
                        {note.checkDone}/{note.checkTotal}
                    </span>
                </div>
            )}
        </div>
    );
}
