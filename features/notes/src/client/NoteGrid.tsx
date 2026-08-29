import { useCallback, useEffect, useRef } from 'react';

import styles from './style.module.css';

import NoteCard from './NoteCard';

import type { NoteFolder, NoteSummary } from '../contracts/domain';

interface NoteGridProps {
    /** One folder's notes, already in the user's order. */
    notes: NoteSummary[];
    folders: NoteFolder[];
    folderId: number | null;
    /** Off while searching: a filtered grid isn't the real order. */
    reorderable: boolean;
    onOpen: (note: NoteSummary) => void;
    onMove: (note: NoteSummary, folderId: number | null) => void;
    onAdd: () => void;
    onDragStart: (note: NoteSummary) => void;
    onDragEnd: () => void;
    /** A note was dropped in the gap at `index` of this folder. */
    onDropAt: (folderId: number | null, index: number) => void;
}

function halfGap(grid: HTMLElement): number {
    return (parseFloat(getComputedStyle(grid).columnGap) || 0) / 2;
}

/**
 * The whole grid is the drop target (events bubble up from the cards) and the
 * landing spot is a bar standing in the gap, the cards themselves never move.
 *
 * The bar is driven straight through the DOM, never React state: `dragover`
 * fires continuously, and re-rendering the cards under the pointer makes the
 * browser re-fire drag events on the replaced nodes, which loops back into
 * another render and locks the tab up.
 */
export default function NoteGrid({
    notes,
    folders,
    folderId,
    reorderable,
    onOpen,
    onMove,
    onAdd,
    onDragStart,
    onDragEnd,
    onDropAt
}: NoteGridProps) {
    const gridRef = useRef<HTMLDivElement>(null);
    const barRef = useRef<HTMLSpanElement>(null);
    /** Gap the bar currently marks, or null while it is hidden. */
    const gapRef = useRef<number | null>(null);

    const cardEls = useCallback(
        () => Array.from(gridRef.current?.querySelectorAll<HTMLElement>('[data-note-card]') ?? []),
        []
    );

    const hideBar = useCallback(() => {
        gapRef.current = null;
        gridRef.current?.classList.remove(styles.dragging);
        if (barRef.current) barRef.current.style.opacity = '0';
    }, []);

    /** Stand the bar in gap `index` (0 = before the first card). */
    const showBar = useCallback(
        (index: number) => {
            const grid = gridRef.current;
            const bar = barRef.current;
            if (!grid || !bar || gapRef.current === index) return;

            // Every gap is "just ahead of" something: the card the note would land
            // before, or the add card at the end. Anchoring on an always-leading
            // edge keeps the bar centred; the last card's trailing edge would
            // offset it by a gap.
            const anchor = cardEls()[index] ?? grid.querySelector<HTMLElement>('[data-add-card]');
            if (!anchor) return;

            gapRef.current = index;
            // Card hovers lift the card 2px; freeze that while a note is in flight
            // or the bar rides along with whatever the pointer passes over.
            grid.classList.add(styles.dragging);
            const gridBox = grid.getBoundingClientRect();
            const box = anchor.getBoundingClientRect();
            // Middle of the gap ahead of the anchor, less half the bar's own width
            // (read from the DOM so it stays defined only in the CSS), clamped so
            // the very first gap stays inside the grid.
            const x = Math.max(box.left - gridBox.left - halfGap(grid) - bar.offsetWidth / 2, 0);
            bar.style.transform = `translate(${x}px, ${box.top - gridBox.top}px)`;
            bar.style.height = `${box.height}px`;
            bar.style.opacity = '1';
        },
        [cardEls]
    );

    /**
     * Both vertical edges of every card are candidate gaps, picked by plain
     * distance, which handles a wrapping grid without reasoning about rows.
     */
    const gapAt = useCallback(
        (clientX: number, clientY: number): number => {
            let best = 0;
            let bestDistance = Infinity;
            for (const [i, el] of cardEls().entries()) {
                const box = el.getBoundingClientRect();
                const middle = box.top + box.height / 2;
                for (const [x, gap] of [
                    [box.left, i],
                    [box.right, i + 1]
                ]) {
                    const distance = Math.hypot(clientX - x, clientY - middle);
                    if (distance < bestDistance) {
                        bestDistance = distance;
                        best = gap;
                    }
                }
            }
            return best;
        },
        [cardEls]
    );

    // A drop outside this grid (another folder, or nowhere) never reaches its
    // handlers, so the bar is also cleared whenever any drag ends.
    useEffect(() => {
        document.addEventListener('dragend', hideBar);
        return () => document.removeEventListener('dragend', hideBar);
    }, [hideBar]);

    function handleDragOver(e: React.DragEvent) {
        e.preventDefault(); // required for the drop to be allowed at all
        e.dataTransfer.dropEffect = 'move';
        showBar(gapAt(e.clientX, e.clientY));
    }

    function handleDrop(e: React.DragEvent) {
        e.preventDefault();
        const index = gapRef.current;
        hideBar();
        if (index !== null) onDropAt(folderId, index);
    }

    function handleDragLeave(e: React.DragEvent) {
        // Moving between cards fires dragleave too; only a real exit hides the bar.
        if (!gridRef.current?.contains(e.relatedTarget as Node | null)) hideBar();
    }

    return (
        <div
            ref={gridRef}
            className={styles.grid}
            onDragOver={reorderable ? handleDragOver : undefined}
            onDrop={reorderable ? handleDrop : undefined}
            onDragLeave={reorderable ? handleDragLeave : undefined}
        >
            {notes.map((note) => (
                <NoteCard
                    key={note.id}
                    note={note}
                    folders={folders}
                    // Une note projetée garde le rang de son domicile : le serveur
                    // refuse un ordre qui l'inclut.
                    draggable={reorderable && !note.foreign}
                    onOpen={onOpen}
                    onMove={onMove}
                    onDragStart={onDragStart}
                    onDragEnd={onDragEnd}
                />
            ))}
            {reorderable && (
                <button
                    type='button'
                    data-add-card=''
                    className={styles.addCard}
                    aria-label='Ajouter une note'
                    title='Ajouter une note'
                    onClick={onAdd}
                >
                    <span className={`icon ${styles.addCardIcon} icon-add`} />
                </button>
            )}
            {reorderable && <span ref={barRef} className={styles.dropBar} aria-hidden='true' />}
        </div>
    );
}
