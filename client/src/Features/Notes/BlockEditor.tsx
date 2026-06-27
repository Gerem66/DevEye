import { Fragment, useCallback, useEffect, useRef, useState } from 'react';

import styles from './style.module.css';

import type { NoteBlock } from 'deveye-types';

interface BlockEditorProps {
    blocks: NoteBlock[];
    onChange: (blocks: NoteBlock[]) => void;
    /** Content shown right-aligned on the add-block row (e.g. the note's
     *  created/updated stamps), so it shares that line rather than taking one
     *  of its own. */
    aside?: React.ReactNode;
}

/**
 * Markdown-ish prefix that turns a paragraph into a checklist item as soon as
 * it is typed at the very start of a line: `[]`, `[ ]`, `- []`, `- [ ]`
 * (optionally followed by a space). Only the prefix is stripped — any text
 * already on the line is preserved as the item's content.
 */
const CHECK_TRIGGER = /^(?:- )?\[ ?\] ?/;

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
 * checklist item). One clean surface that reads like a native notes editor:
 *  - Enter splits the block at the caret into a sibling of the same kind (a
 *    paragraph spawns a paragraph, a checklist item a new item).
 *  - Ctrl/⌘+Enter inserts a literal line break inside the current block.
 *  - Backspace at the start of a checklist item demotes it to a paragraph
 *    before it can be removed; on an empty paragraph it removes the row.
 *  - Typing a `[]`/`- [ ]`-style prefix at the start of a paragraph turns it
 *    into a checklist item (see CHECK_TRIGGER).
 * New blocks can also be added explicitly through the discreet "+" menu.
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
export default function BlockEditor({ blocks, onChange, aside }: BlockEditorProps) {
    const refs = useRef<(HTMLTextAreaElement | null)[]>([]);
    const rowRefs = useRef<(HTMLDivElement | null)[]>([]);
    const focusIndex = useRef<number | null>(null);
    /** Where to drop the caret in the focused block; null = end of its value. */
    const caretPos = useRef<number | null>(null);
    const [drag, setDrag] = useState<DragState | null>(null);
    const [addMenuOpen, setAddMenuOpen] = useState(false);
    const addMenuRef = useRef<HTMLDivElement | null>(null);

    // After a structural change we may want to move focus to a specific block.
    useEffect(() => {
        if (focusIndex.current === null) return;
        const el = refs.current[focusIndex.current];
        if (el) {
            el.focus();
            const pos = caretPos.current ?? el.value.length;
            el.setSelectionRange(pos, pos);
            autosize(el);
        }
        focusIndex.current = null;
        caretPos.current = null;
    });

    // Close the add menu on an outside click (same lightweight pattern as the
    // per-card move menu).
    useEffect(() => {
        if (!addMenuOpen) return;
        const onDocClick = (e: MouseEvent) => {
            if (addMenuRef.current && !addMenuRef.current.contains(e.target as Node)) setAddMenuOpen(false);
        };
        document.addEventListener('mousedown', onDocClick);
        return () => document.removeEventListener('mousedown', onDocClick);
    }, [addMenuOpen]);

    const update = useCallback(
        (index: number, patch: Partial<NoteBlock>) => {
            onChange(blocks.map((b, i) => (i === index ? ({ ...b, ...patch } as NoteBlock) : b)));
        },
        [blocks, onChange]
    );

    /** Replace a whole block (used to switch its type), focusing it at `caret`. */
    const replaceBlock = useCallback(
        (index: number, block: NoteBlock, caret: number | null = null) => {
            focusIndex.current = index;
            caretPos.current = caret;
            onChange(blocks.map((b, i) => (i === index ? block : b)));
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

    /** Split block `index` at the caret: it keeps `before`, `next` follows it. */
    const splitAt = useCallback(
        (index: number, before: string, next: NoteBlock) => {
            const blocksNext = blocks.map((b, i) => (i === index ? ({ ...b, text: before } as NoteBlock) : b));
            blocksNext.splice(index + 1, 0, next);
            focusIndex.current = index + 1;
            caretPos.current = 0;
            onChange(blocksNext);
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
            const ta = e.currentTarget;
            if (e.key === 'Enter') {
                if (e.ctrlKey || e.metaKey) {
                    // Ctrl+Enter (or ⌘+Enter on Mac) inserts a line break in place.
                    e.preventDefault();
                    const text = b.text.slice(0, ta.selectionStart) + '\n' + b.text.slice(ta.selectionEnd);
                    replaceBlock(index, { ...b, text } as NoteBlock, ta.selectionStart + 1);
                    return;
                }
                // Plain Enter splits into a sibling of the same kind.
                e.preventDefault();
                const before = b.text.slice(0, ta.selectionStart);
                const after = b.text.slice(ta.selectionEnd);
                splitAt(
                    index,
                    before,
                    b.type === 'check' ? { type: 'check', text: after, done: false } : { type: 'text', text: after }
                );
                return;
            }
            if (e.key === 'Backspace' && ta.selectionStart === 0 && ta.selectionEnd === 0) {
                // At the start of a checklist item, demote it to a paragraph
                // (keeping its text) before it can be removed by a second press.
                if (b.type === 'check') {
                    e.preventDefault();
                    replaceBlock(index, { type: 'text', text: b.text }, 0);
                    return;
                }
                if (b.text === '' && blocks.length > 1) {
                    e.preventDefault();
                    removeAt(index);
                }
            }
        },
        [blocks, replaceBlock, splitAt, removeAt]
    );

    const onTextChange = useCallback(
        (e: React.ChangeEvent<HTMLTextAreaElement>, index: number) => {
            const value = e.target.value;
            const block = blocks[index];
            // Typing a checklist prefix at the start of a paragraph converts it
            // to a checklist item, keeping any text that already followed.
            if (block.type === 'text') {
                const m = CHECK_TRIGGER.exec(value);
                if (m) {
                    replaceBlock(index, { type: 'check', text: value.slice(m[0].length), done: false }, 0);
                    autosize(e.target);
                    return;
                }
            }
            update(index, { text: value });
            autosize(e.target);
        },
        [blocks, replaceBlock, update]
    );

    const addBlock = useCallback(
        (block: NoteBlock) => {
            setAddMenuOpen(false);
            insertAfter(blocks.length - 1, block);
        },
        [blocks.length, insertAfter]
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
                onChange={(e) => onTextChange(e, index)}
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
        <>
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
            </div>

            <div className={styles.addMenu} ref={addMenuRef}>
                <button
                    type='button'
                    className={styles.addMenuBtn}
                    aria-label='Ajouter un bloc'
                    aria-expanded={addMenuOpen}
                    title='Ajouter un bloc'
                    onClick={() => setAddMenuOpen((v) => !v)}
                >
                    <span className={`icon ${styles.toggleIcon} icon-add`} />
                </button>
                {addMenuOpen && (
                    <div className={`${styles.menu} ${styles.addMenuList}`}>
                        <button
                            type='button'
                            className={styles.menuItem}
                            onClick={() => addBlock({ type: 'text', text: '' })}
                        >
                            <span className={`icon ${styles.toggleIcon} icon-add`} /> Paragraphe
                        </button>
                        <button
                            type='button'
                            className={styles.menuItem}
                            onClick={() => addBlock({ type: 'check', text: '', done: false })}
                        >
                            <span className={`icon ${styles.toggleIcon} icon-square-empty`} /> Case à cocher
                        </button>
                    </div>
                )}
                {aside}
            </div>
        </>
    );
}
