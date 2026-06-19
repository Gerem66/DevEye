import { Fragment, useCallback, useEffect, useRef, useState } from 'react';

import styles from './style.module.css';

import type { NoteBlock } from 'deveye-types';

interface BlockEditorProps {
    blocks: NoteBlock[];
    onChange: (blocks: NoteBlock[]) => void;
}

/** Auto-grow a textarea to fit its content (no inner scrollbar). */
function autosize(el: HTMLTextAreaElement | null): void {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
}

interface DragState {
    /** Original index of the row being dragged. */
    from: number;
    /** Insertion position among the *remaining* rows (0..length-1): where the
     *  dragged row would land if dropped now. */
    to: number;
    /** Add to `clientY` to get the dragged row's vertical centre — so the switch
     *  is driven by the element's middle, not wherever the grip was grabbed. */
    centerOffset: number;
    /** Ascending Y boundaries (viewport px) *between* consecutive rows in the
     *  resting layout, frozen at drag start. `to` = how many boundaries the
     *  dragged row's centre has passed. Boundaries (not midpoints) make the
     *  switch symmetric: the centre rests exactly half a row from each, so
     *  half a row up flips to the previous slot and half a row down to the next.
     *  Independent of which row is dragged, and free of any reflow feedback. */
    thresholds: number[];
}

/**
 * The modular note body: an ordered list of typed blocks (paragraph or
 * checklist item). One clean surface — Enter splits into a new block of the
 * same kind, Backspace at the start of an empty block removes it and focuses the
 * previous one, so it reads like a native notes editor rather than a form.
 *
 * Rows reorder by dragging the grip on the left:
 *  - The grabbed row's element is handed to `setDragImage`, so the browser
 *    trails a translucent copy under the cursor — no manual positioning, immune
 *    to the popup's ancestor transforms.
 *  - The source row collapses for the whole drag (kept mounted so `dragend`
 *    still fires) and a single placeholder of the same height marks where it
 *    will land. One mechanism, no special-casing of the original slot.
 *  - The target is computed from thresholds frozen at drag start, so the
 *    cursor→slot mapping never oscillates as the layout shifts.
 */
export default function BlockEditor({ blocks, onChange }: BlockEditorProps) {
    const refs = useRef<(HTMLTextAreaElement | null)[]>([]);
    const rowRefs = useRef<(HTMLDivElement | null)[]>([]);
    const focusIndex = useRef<number | null>(null);
    const [drag, setDrag] = useState<DragState | null>(null);

    // After a structural change we may want to move focus to a specific block.
    useEffect(() => {
        if (focusIndex.current === null) return;
        const el = refs.current[focusIndex.current];
        if (el) {
            el.focus();
            const end = el.value.length;
            el.setSelectionRange(end, end);
            autosize(el);
        }
        focusIndex.current = null;
    });

    const update = useCallback(
        (index: number, patch: Partial<NoteBlock>) => {
            onChange(blocks.map((b, i) => (i === index ? ({ ...b, ...patch } as NoteBlock) : b)));
        },
        [blocks, onChange]
    );

    const toggleDone = useCallback(
        (index: number) => {
            const b = blocks[index];
            if (b.type !== 'check') return;
            update(index, { done: !b.done });
        },
        [blocks, update]
    );

    const insertAfter = useCallback(
        (index: number, block: NoteBlock) => {
            const next = [...blocks.slice(0, index + 1), block, ...blocks.slice(index + 1)];
            focusIndex.current = index + 1;
            onChange(next);
        },
        [blocks, onChange]
    );

    const removeAt = useCallback(
        (index: number) => {
            const next = blocks.filter((_, i) => i !== index);
            focusIndex.current = Math.max(0, index - 1);
            onChange(next);
        },
        [blocks, onChange]
    );

    const onKeyDown = useCallback(
        (e: React.KeyboardEvent<HTMLTextAreaElement>, index: number) => {
            const b = blocks[index];
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                // Ctrl+Enter (or ⌘+Enter on Mac) creates a sibling block.
                e.preventDefault();
                insertAfter(
                    index,
                    b.type === 'check' ? { type: 'check', text: '', done: false } : { type: 'text', text: '' }
                );
                return;
            }
            if (e.key === 'Backspace' && b.text === '' && blocks.length > 1) {
                e.preventDefault();
                removeAt(index);
            }
        },
        [blocks, insertAfter, removeAt]
    );

    const onGripDragStart = useCallback(
        (e: React.DragEvent, index: number) => {
            const row = rowRefs.current[index];
            if (!row) return;
            const rect = row.getBoundingClientRect();
            // Where the centre of the row sits relative to the cursor, so the
            // target follows the element's middle rather than the grab point.
            const centerOffset = rect.height / 2 - (e.clientY - rect.top);

            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', String(index));
            // Snapshot the row as the floating ghost before it collapses.
            e.dataTransfer.setDragImage(row, e.clientX - rect.left, e.clientY - rect.top);

            // Boundaries between consecutive rows = midpoints of adjacent row
            // centres (see DragState.thresholds).
            const mids = blocks.map((_, i) => {
                const r = rowRefs.current[i]?.getBoundingClientRect();
                return r ? r.top + r.height / 2 : Number.POSITIVE_INFINITY;
            });
            const thresholds: number[] = [];
            for (let i = 0; i < mids.length - 1; i++) {
                thresholds.push((mids[i] + mids[i + 1]) / 2);
            }

            // Defer the state update: collapsing the source synchronously inside
            // dragstart would destroy the dragged element's box and abort the drag.
            requestAnimationFrame(() => setDrag({ from: index, to: index, centerOffset, thresholds }));
        },
        [blocks]
    );

    const onContainerDragOver = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const { clientY } = e;
        setDrag((d) => {
            if (!d) return d;
            // Compare the dragged row's centre, not the cursor, against the
            // rows' midpoints: the slot flips once the element is half past.
            const center = clientY + d.centerOffset;
            let to = 0;
            while (to < d.thresholds.length && center >= d.thresholds[to]) to++;
            return d.to === to ? d : { ...d, to };
        });
    }, []);

    const finishDrag = useCallback(() => {
        setDrag((d) => {
            if (d && d.to !== d.from) {
                const next = blocks.filter((_, i) => i !== d.from);
                next.splice(d.to, 0, blocks[d.from]);
                onChange(next);
            }
            return null;
        });
    }, [blocks, onChange]);

    // Render order, with the placeholder injected among the remaining rows.
    // `placeholderBefore` is the original index the gap sits before, or -1 for
    // "after the last row".
    const remaining = drag === null ? [] : blocks.map((_, i) => i).filter((i) => i !== drag.from);
    const placeholderBefore = drag === null ? null : drag.to < remaining.length ? remaining[drag.to] : -1;

    const renderRow = (block: NoteBlock, index: number) => (
        <div
            key={index}
            ref={(el) => {
                rowRefs.current[index] = el;
            }}
            className={`${styles.block} ${drag?.from === index ? styles.blockHidden : ''}`}
        >
            <button
                type='button'
                className={styles.blockGrip}
                aria-label='Réordonner la ligne'
                draggable
                onDragStart={(e) => onGripDragStart(e, index)}
                onDragEnd={() => setDrag(null)}
            >
                <span className={`icon ${styles.badge} icon-drag`} />
            </button>
            {block.type === 'check' && (
                <button
                    type='button'
                    className={`${styles.checkButton} ${block.done ? styles.checkButtonDone : ''}`}
                    aria-label={block.done ? 'Décocher' : 'Cocher'}
                    onClick={() => toggleDone(index)}
                >
                    <span className={`icon ${styles.badge} icon-${block.done ? 'square-check' : 'square-empty'}`} />
                </button>
            )}
            <textarea
                ref={(el) => {
                    refs.current[index] = el;
                    autosize(el);
                }}
                className={`${styles.blockText} ${block.type === 'check' && block.done ? styles.blockTextDone : ''}`}
                rows={1}
                value={block.text}
                placeholder={block.type === 'check' ? 'Élément…' : 'Écrivez quelque chose…'}
                onChange={(e) => {
                    update(index, { text: e.target.value });
                    autosize(e.target);
                }}
                onKeyDown={(e) => onKeyDown(e, index)}
            />
            {blocks.length > 1 && (
                <button
                    type='button'
                    className={styles.blockRemove}
                    aria-label='Supprimer la ligne'
                    onClick={() => removeAt(index)}
                >
                    <span className={`icon ${styles.badge} icon-trash`} />
                </button>
            )}
        </div>
    );

    // Landing preview: a translucent copy of the dragged block, shown at the
    // target slot so its real content makes clear what lands where. It mirrors
    // the row's content, so it naturally takes the same height as the source.
    const placeholder =
        drag !== null &&
        (() => {
            const b = blocks[drag.from];
            return (
                <div className={styles.blockGhost} aria-hidden='true'>
                    <span className={`icon ${styles.badge} ${styles.ghostGrip} icon-drag`} />
                    {b.type === 'check' && (
                        <span
                            className={`icon ${styles.badge} ${styles.ghostCheck} icon-${
                                b.done ? 'square-check' : 'square-empty'
                            }`}
                        />
                    )}
                    <span className={`${styles.ghostText} ${b.type === 'check' && b.done ? styles.blockTextDone : ''}`}>
                        {b.text || (b.type === 'check' ? 'Élément…' : 'Écrivez quelque chose…')}
                    </span>
                </div>
            );
        })();

    return (
        <div
            className={`${styles.blocks} ${drag !== null ? styles.dragging : ''}`}
            onDragOver={onContainerDragOver}
            onDrop={finishDrag}
        >
            {blocks.map((block, index) => (
                <Fragment key={index}>
                    {placeholderBefore === index && placeholder}
                    {renderRow(block, index)}
                </Fragment>
            ))}
            {placeholderBefore === -1 && placeholder}

            <div className={styles.addBlockRow}>
                <button
                    type='button'
                    className={styles.addBlockBtn}
                    onClick={() => insertAfter(blocks.length - 1, { type: 'text', text: '' })}
                >
                    <span className={`icon ${styles.toggleIcon} icon-add`} /> Paragraphe
                </button>
                <button
                    type='button'
                    className={styles.addBlockBtn}
                    onClick={() => insertAfter(blocks.length - 1, { type: 'check', text: '', done: false })}
                >
                    <span className={`icon ${styles.toggleIcon} icon-square-empty`} /> Case à cocher
                </button>
            </div>
        </div>
    );
}
