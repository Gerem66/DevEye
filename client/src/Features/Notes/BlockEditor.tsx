import { Fragment, useCallback, useEffect, useRef, useState } from 'react';

import styles from './style.module.css';
import RichText, { type RichTextHandle } from './RichText';
import {
    stripInline,
    MARK_DELIMITERS,
    colorOpen,
    COLOR_CLOSE,
    stripColorMarkers,
    removeEnclosingColor,
    type InlineMark
} from './markdown';
import { NOTE_COLOR_OPTIONS, colorVar } from './noteColors';

import type {
    NoteBlock,
    NoteBulletBlock,
    NoteCheckBlock,
    NoteColor,
    NoteDividerBlock,
    NoteNumberBlock
} from 'deveye-types';

/** A block whose marker (dot / ordinal / box / rule) can be tinted. */
type MarkerBlock = NoteBulletBlock | NoteNumberBlock | NoteCheckBlock | NoteDividerBlock;

const MARKER_TYPES = new Set<NoteBlock['type']>(['bullet', 'number', 'check', 'divider']);

/** Narrowing guard so the format menu can read a marker block's `color`. */
function isMarkerBlock(block: NoteBlock): block is MarkerBlock {
    return MARKER_TYPES.has(block.type);
}

/** The format menu's contextual label for a marker block's colour picker. */
function markerColorLabel(type: NoteBlock['type']): string {
    switch (type) {
        case 'bullet':
            return 'Couleur de la puce';
        case 'number':
            return 'Couleur du numéro';
        case 'check':
            return 'Couleur de la case';
        case 'divider':
            return 'Couleur du trait';
        default:
            return 'Couleur du marqueur';
    }
}

interface BlockEditorProps {
    blocks: NoteBlock[];
    onChange: (blocks: NoteBlock[]) => void;
    /** Let the block list flex to fill its parent and be the only scroll area
     *  (used when the editor popup is in its large, fixed-height layout). */
    fill?: boolean;
    /** The note's icon actions (delete / pin / lock / export). */
    footerActions?: React.ReactNode;
    /** The created/modified stamps. */
    footerDates?: React.ReactNode;
    /** The cancel / save buttons. */
    footerButtons?: React.ReactNode;
    /** Rendered between the block list and the footer (e.g. a pending privacy change). */
    notice?: React.ReactNode;
}

/**
 * Markdown-ish prefix that turns a paragraph into a checklist item as soon as
 * it is typed at the very start of a line: `[]`, `[ ]`, `- []`, `- [ ]`
 * (optionally followed by a space). Only the prefix is stripped — any text
 * already on the line is preserved as the item's content.
 */
const CHECK_TRIGGER = /^(?:- )?\[ ?\] ?/;

/** `- ` (or `* `) at the very start turns a paragraph into a bullet list item. */
const BULLET_TRIGGER = /^[-*] /;

/** `1. ` / `1) ` (any number) at the start turns it into a numbered list item. */
const NUMBER_TRIGGER = /^\d+[.)] /;

/** `# `…`##### ` at the start turns a paragraph into a heading of that level. */
const HEADING_TRIGGER = /^(#{1,5}) /;

/** A whole-line `---` turns the paragraph into a horizontal divider. */
const DIVIDER_TRIGGER = '---';

/** Whether a block kind carries editable text (i.e. renders a RichText surface). */
/**
 * Heading size class for a block. `level` is 1–5 per the note schema but typed
 * as a plain `number`, so it can't index the stylesheet directly.
 */
function headingClass(level: number): string {
    const classes = [styles.heading1, styles.heading2, styles.heading3, styles.heading4, styles.heading5];
    return classes[level - 1] ?? styles.heading1;
}

function isEditable(block: NoteBlock): boolean {
    return block.type !== 'divider';
}

/** A fresh block to follow `b` when Enter splits it (a heading yields a paragraph). */
function siblingBlock(b: NoteBlock, text: string): NoteBlock {
    switch (b.type) {
        case 'check':
            return { type: 'check', text, done: false };
        case 'bullet':
            return { type: 'bullet', text };
        case 'number':
            return { type: 'number', text };
        default:
            return { type: 'text', text };
    }
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
 * The modular note body: an ordered list of typed blocks (paragraph, heading,
 * checklist / list item, divider). One clean surface that reads like a native
 * notes editor:
 *  - Enter splits the block at the caret into a sibling of the same kind (a
 *    heading yields a paragraph).
 *  - Ctrl/⌘+Enter inserts a literal line break inside the current block.
 *  - Up/Down cross block boundaries from the edge lines, skipping dividers.
 *  - Backspace at the start of a typed item / heading demotes it to a paragraph;
 *    on an empty paragraph it removes the row.
 *  - Start-of-line prefixes convert a paragraph: `[]` → checklist, `- ` → bullet,
 *    `1. ` → numbered, `# `…`##### ` → heading, a lone `---` → divider.
 *
 * Inline emphasis (bold/italic/underline/strike) is typed as markdown markers
 * and rendered live by {@link RichText}; the "Aa" menu wraps the selection.
 * New blocks are added through the discreet "+" menu.
 *
 * Rows reorder by dragging the grip on the left (see {@link DragState}).
 */
export default function BlockEditor({
    blocks,
    onChange,
    fill,
    footerActions,
    footerDates,
    footerButtons,
    notice
}: BlockEditorProps) {
    const refs = useRef<(RichTextHandle | null)[]>([]);
    const rowRefs = useRef<(HTMLDivElement | null)[]>([]);
    const focusIndex = useRef<number | null>(null);
    /** Where to drop the caret in the focused block; null = end of its value. */
    const caretPos = useRef<number | null>(null);
    /** The block currently targeted by the format menu — the RichText that holds
     *  focus, or a divider the user clicked. Drives the contextual colour picker. */
    const [active, setActive] = useState<number | null>(null);
    const [drag, setDrag] = useState<DragState | null>(null);
    const [addMenuOpen, setAddMenuOpen] = useState(false);
    const [formatMenuOpen, setFormatMenuOpen] = useState(false);
    const addMenuRef = useRef<HTMLDivElement | null>(null);
    const formatMenuRef = useRef<HTMLDivElement | null>(null);

    // After a structural change we may want to move focus to a specific block.
    useEffect(() => {
        if (focusIndex.current === null) return;
        const handle = refs.current[focusIndex.current];
        const block = blocks[focusIndex.current];
        if (handle && block) {
            handle.focus();
            const len = 'text' in block ? block.text.length : 0;
            handle.setCaret(caretPos.current ?? len);
        }
        focusIndex.current = null;
        caretPos.current = null;
    });

    // Close the menus on an outside click (same lightweight pattern as the
    // per-card move menu).
    useEffect(() => {
        if (!addMenuOpen && !formatMenuOpen) return;
        const onDocClick = (e: MouseEvent) => {
            if (addMenuRef.current && !addMenuRef.current.contains(e.target as Node)) setAddMenuOpen(false);
            if (formatMenuRef.current && !formatMenuRef.current.contains(e.target as Node)) setFormatMenuOpen(false);
        };
        document.addEventListener('mousedown', onDocClick);
        return () => document.removeEventListener('mousedown', onDocClick);
    }, [addMenuOpen, formatMenuOpen]);

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

    /** Nearest editable block index from `from` walking in `dir` (±1), or -1. */
    const editableNeighbor = useCallback(
        (from: number, dir: 1 | -1) => {
            for (let i = from + dir; i >= 0 && i < blocks.length; i += dir) {
                if (isEditable(blocks[i])) return i;
            }
            return -1;
        },
        [blocks]
    );

    /** Move focus to block `index`, dropping the caret at `caret` (clamped). */
    const focusBlock = useCallback((index: number, caret: number) => {
        const handle = refs.current[index];
        if (!handle) return;
        handle.focus();
        handle.setCaret(Math.max(0, caret));
    }, []);

    const onKeyDown = useCallback(
        (e: React.KeyboardEvent<HTMLDivElement>, index: number) => {
            const b = blocks[index];
            if (!('text' in b)) return;
            const handle = refs.current[index];
            if (!handle) return;
            const { start, end } = handle.getCaret();

            // Up/Down cross block boundaries only from the edge lines, skipping
            // dividers: on the first text line, Up moves to the previous editable
            // block; on the last line, Down moves to the next. The caret column is
            // carried over.
            if (e.key === 'ArrowUp' && start === end) {
                const lineStart = b.text.lastIndexOf('\n', start - 1) + 1;
                const prevIndex = editableNeighbor(index, -1);
                if (lineStart === 0 && prevIndex !== -1) {
                    e.preventDefault();
                    const prev = blocks[prevIndex];
                    const prevText = 'text' in prev ? prev.text : '';
                    const prevLineStart = prevText.lastIndexOf('\n') + 1;
                    focusBlock(prevIndex, prevLineStart + start);
                    return;
                }
            }
            if (e.key === 'ArrowDown' && start === end) {
                const nextIndex = editableNeighbor(index, 1);
                if (b.text.indexOf('\n', start) === -1 && nextIndex !== -1) {
                    e.preventDefault();
                    const lineStart = b.text.lastIndexOf('\n', start - 1) + 1;
                    const column = start - lineStart;
                    const next = blocks[nextIndex];
                    const nextText = 'text' in next ? next.text : '';
                    const nextLineEnd = nextText.indexOf('\n');
                    const firstLineLen = nextLineEnd === -1 ? nextText.length : nextLineEnd;
                    focusBlock(nextIndex, Math.min(column, firstLineLen));
                    return;
                }
            }
            if (e.key === 'Enter') {
                if (e.ctrlKey || e.metaKey) {
                    // Ctrl+Enter (or ⌘+Enter on Mac) inserts a line break in place.
                    e.preventDefault();
                    const text = b.text.slice(0, start) + '\n' + b.text.slice(end);
                    replaceBlock(index, { ...b, text } as NoteBlock, start + 1);
                    return;
                }
                // Plain Enter splits into a sibling of the same kind.
                e.preventDefault();
                splitAt(index, b.text.slice(0, start), siblingBlock(b, b.text.slice(end)));
                return;
            }
            if (e.key === 'Backspace' && start === 0 && end === 0) {
                // At the start of a typed item / heading, demote it to a plain
                // paragraph (keeping its text) before it can be removed.
                if (b.type !== 'text') {
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
        [blocks, replaceBlock, splitAt, removeAt, focusBlock, editableNeighbor]
    );

    const handleBlockChange = useCallback(
        (index: number, value: string) => {
            const block = blocks[index];
            // Start-of-line prefixes convert a paragraph to another kind, keeping
            // any text that already followed.
            if (block.type === 'text') {
                const check = CHECK_TRIGGER.exec(value);
                if (check)
                    return replaceBlock(index, { type: 'check', text: value.slice(check[0].length), done: false }, 0);
                const bullet = BULLET_TRIGGER.exec(value);
                if (bullet) return replaceBlock(index, { type: 'bullet', text: value.slice(bullet[0].length) }, 0);
                const number = NUMBER_TRIGGER.exec(value);
                if (number) return replaceBlock(index, { type: 'number', text: value.slice(number[0].length) }, 0);
                const heading = HEADING_TRIGGER.exec(value);
                if (heading) {
                    return replaceBlock(
                        index,
                        { type: 'heading', text: value.slice(heading[0].length), level: heading[1].length },
                        0
                    );
                }
                if (value === DIVIDER_TRIGGER) {
                    // Turn the paragraph into a divider and continue typing below it.
                    const next = blocks.map((b, i) => (i === index ? ({ type: 'divider' } as NoteBlock) : b));
                    next.splice(index + 1, 0, { type: 'text', text: '' });
                    focusIndex.current = index + 1;
                    caretPos.current = 0;
                    onChange(next);
                    return;
                }
            }
            update(index, { text: value });
        },
        [blocks, replaceBlock, update, onChange]
    );

    /** Wrap the active block's selection (or insert an empty pair) with a mark. */
    const applyMark = useCallback(
        (mark: InlineMark) => {
            setFormatMenuOpen(false);
            const index = active;
            if (index === null) return;
            const handle = refs.current[index];
            const b = blocks[index];
            if (!handle || !b || b.type === 'divider') return;
            const { start, end } = handle.getCaret();
            const delim = MARK_DELIMITERS[mark];
            const text = b.text;
            if (start === end) {
                const next = text.slice(0, start) + delim + delim + text.slice(start);
                replaceBlock(index, { ...b, text: next }, start + delim.length);
            } else {
                const next = text.slice(0, start) + delim + text.slice(start, end) + delim + text.slice(end);
                replaceBlock(index, { ...b, text: next }, end + 2 * delim.length);
            }
        },
        [active, blocks, replaceBlock]
    );

    /** Colour the active block's selection with `color` (wrap in `{c:…}{/c}`). An
     *  empty selection inserts the pair and drops the caret inside it, so what's
     *  typed next is coloured — mirroring {@link applyMark}. */
    const applyColor = useCallback(
        (color: NoteColor) => {
            setFormatMenuOpen(false);
            const index = active;
            if (index === null) return;
            const handle = refs.current[index];
            const b = blocks[index];
            if (!handle || !b || b.type === 'divider') return;
            const { start, end } = handle.getCaret();
            const open = colorOpen(color);
            const text = b.text;
            if (start === end) {
                const next = text.slice(0, start) + open + COLOR_CLOSE + text.slice(start);
                replaceBlock(index, { ...b, text: next }, start + open.length);
            } else {
                const inner = text.slice(start, end);
                const next = text.slice(0, start) + open + inner + COLOR_CLOSE + text.slice(end);
                replaceBlock(index, { ...b, text: next }, end + open.length);
            }
        },
        [active, blocks, replaceBlock]
    );

    /** Clear text colour: strip colour markers within the selection, or — with a
     *  collapsed caret — from the coloured run under it. */
    const clearColor = useCallback(() => {
        setFormatMenuOpen(false);
        const index = active;
        if (index === null) return;
        const handle = refs.current[index];
        const b = blocks[index];
        if (!handle || !b || b.type === 'divider') return;
        const { start, end } = handle.getCaret();
        const text = b.text;
        if (start !== end) {
            const inner = stripColorMarkers(text.slice(start, end));
            const next = text.slice(0, start) + inner + text.slice(end);
            replaceBlock(index, { ...b, text: next }, start + inner.length);
            return;
        }
        const cleared = removeEnclosingColor(text, start);
        if (cleared) replaceBlock(index, { ...b, text: cleared.text }, cleared.caret);
    }, [active, blocks, replaceBlock]);

    /** Set (or clear, with `undefined`) the marker colour of the active marker
     *  block — the bullet dot, ordinal, checkbox or divider rule. */
    const setBlockColor = useCallback(
        (color: NoteColor | undefined) => {
            setFormatMenuOpen(false);
            const index = active;
            if (index === null) return;
            const b = blocks[index];
            if (!b || !MARKER_TYPES.has(b.type)) return;
            onChange(blocks.map((bb, i) => (i === index ? ({ ...bb, color } as NoteBlock) : bb)));
        },
        [active, blocks, onChange]
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
            // The row is transparent and sits on translucent popups, so
            // snapshotting it in place bakes whatever is painted underneath
            // (the home grid behind the popups) into the drag ghost. Overlay
            // an opaque clone on the row for one frame and snapshot that.
            const snapshot = row.cloneNode(true) as HTMLElement;
            snapshot.classList.add(styles.dragSnapshot);
            snapshot.style.top = `${rect.top}px`;
            snapshot.style.left = `${rect.left}px`;
            snapshot.style.width = `${rect.width}px`;
            document.body.appendChild(snapshot);
            e.dataTransfer.setDragImage(snapshot, e.clientX - rect.left, e.clientY - rect.top);

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
            requestAnimationFrame(() => {
                snapshot.remove();
                setDrag({ from: index, to: index, centerOffset, thresholds });
            });
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

    const finishDrag = useCallback(
        (e: React.DragEvent) => {
            // Block the browser's native drop handling: dropping over a block's
            // contentEditable would otherwise insert the drag's text/plain payload
            // (the row index) straight into the text.
            e.preventDefault();
            setDrag((d) => {
                if (d && d.to !== d.from) {
                    const next = blocks.filter((_, i) => i !== d.from);
                    next.splice(d.to, 0, blocks[d.from]);
                    onChange(next);
                }
                return null;
            });
        },
        [blocks, onChange]
    );

    // Render order, with the placeholder injected among the remaining rows.
    // `placeholderBefore` is the original index the gap sits before, or -1 for
    // "after the last row".
    const remaining = drag === null ? [] : blocks.map((_, i) => i).filter((i) => i !== drag.from);
    const placeholderBefore = drag === null ? null : drag.to < remaining.length ? remaining[drag.to] : -1;

    // Display index of each numbered item, restarting at 1 after any non-number
    // block — so consecutive numbered rows read 1, 2, 3… and stay coherent.
    const numbering: number[] = [];
    let run = 0;
    for (let i = 0; i < blocks.length; i++) {
        run = blocks[i].type === 'number' ? run + 1 : 0;
        numbering[i] = run;
    }

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
                className={`${styles.blockGrip} ${blocks.length > 1 ? '' : styles.blockGripHidden}`}
                aria-label='Réordonner la ligne'
                draggable={blocks.length > 1}
                onDragStart={(e) => onGripDragStart(e, index)}
                onDragEnd={() => setDrag(null)}
            >
                <span className={`icon ${styles.badge} icon-drag`} />
            </button>
            {block.type === 'check' && (
                <button
                    type='button'
                    className={`${styles.checkButton} ${block.done ? styles.checkButtonDone : ''}`}
                    style={block.color ? { color: colorVar(block.color) } : undefined}
                    aria-label={block.done ? 'Décocher' : 'Cocher'}
                    onClick={() => toggleDone(index)}
                >
                    <span className={`icon ${styles.badge} icon-${block.done ? 'square-check' : 'square-empty'}`} />
                </button>
            )}
            {block.type === 'bullet' && (
                <span
                    className={styles.blockBullet}
                    style={block.color ? { background: colorVar(block.color) } : undefined}
                    aria-hidden='true'
                />
            )}
            {block.type === 'number' && (
                <span
                    className={styles.blockNumber}
                    style={block.color ? { color: colorVar(block.color) } : undefined}
                    aria-hidden='true'
                >
                    {numbering[index]}.
                </span>
            )}
            {block.type === 'divider' ? (
                <div
                    className={`${styles.dividerHit} ${active === index ? styles.dividerSelected : ''}`}
                    role='separator'
                    tabIndex={-1}
                    title='Cliquer pour le sélectionner, puis choisir sa couleur dans le menu de mise en forme'
                    onMouseDown={() => setActive(index)}
                >
                    <div
                        className={styles.dividerLine}
                        style={block.color ? { borderTopColor: colorVar(block.color) } : undefined}
                    />
                </div>
            ) : (
                <RichText
                    ref={(handle) => {
                        refs.current[index] = handle;
                    }}
                    className={`${styles.blockText} ${block.type === 'heading' ? headingClass(block.level) : ''} ${
                        block.type === 'check' && block.done ? styles.blockTextDone : ''
                    }`}
                    value={block.text}
                    placeholder={block.type === 'text' ? 'Écrivez quelque chose…' : 'Élément…'}
                    onChange={(v) => handleBlockChange(index, v)}
                    onKeyDown={(e) => onKeyDown(e, index)}
                    onFocus={() => setActive(index)}
                />
            )}
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
                            style={b.color ? { color: colorVar(b.color) } : undefined}
                        />
                    )}
                    {b.type === 'bullet' && (
                        <span
                            className={styles.blockBullet}
                            style={b.color ? { background: colorVar(b.color) } : undefined}
                        />
                    )}
                    {b.type === 'number' && (
                        <span className={styles.blockNumber} style={b.color ? { color: colorVar(b.color) } : undefined}>
                            {numbering[drag.from]}.
                        </span>
                    )}
                    {b.type === 'divider' ? (
                        <div className={styles.dividerHit}>
                            <div
                                className={styles.dividerLine}
                                style={b.color ? { borderTopColor: colorVar(b.color) } : undefined}
                            />
                        </div>
                    ) : (
                        <span
                            className={`${styles.ghostText} ${b.type === 'check' && b.done ? styles.blockTextDone : ''}`}
                        >
                            {stripInline(b.text) || (b.type === 'text' ? 'Écrivez quelque chose…' : 'Élément…')}
                        </span>
                    )}
                </div>
            );
        })();

    // The block currently targeted by the format menu, and — when it carries a
    // colourable marker — that block, so the menu can offer its marker picker.
    const activeBlock = active !== null ? (blocks[active] ?? null) : null;
    const activeMarkerBlock = activeBlock && isMarkerBlock(activeBlock) ? activeBlock : null;

    // A row of colour swatches (+ a "Défaut" reset), reused by the text-colour
    // and marker-colour pickers. `selected` marks the current choice: a colour
    // highlights its swatch, `null` highlights "Défaut", `undefined` (text
    // colour, where a selection has no single colour) highlights nothing.
    const swatchRow = (onPick: (c: NoteColor) => void, onClear: () => void, selected?: NoteColor | null) => (
        <div className={styles.swatches}>
            {NOTE_COLOR_OPTIONS.map((o) => (
                <button
                    key={o.value}
                    type='button'
                    className={`${styles.swatch} ${selected === o.value ? styles.swatchActive : ''}`}
                    style={{ background: colorVar(o.value) }}
                    title={o.label}
                    aria-label={o.label}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => onPick(o.value)}
                />
            ))}
            <button
                type='button'
                className={`${styles.swatch} ${styles.swatchClear} ${selected === null ? styles.swatchActive : ''}`}
                title='Défaut'
                aria-label='Couleur par défaut'
                onMouseDown={(e) => e.preventDefault()}
                onClick={onClear}
            />
        </div>
    );

    // The "+" (add block) and "Aa" (format) tools — placed in the footer when the
    // editor is large, or on their own row above it when compact.
    const tools = (
        <div className={styles.addTools}>
            <div className={styles.addMenu} ref={addMenuRef}>
                <button
                    type='button'
                    className={styles.addMenuBtn}
                    aria-label='Ajouter un bloc'
                    aria-expanded={addMenuOpen}
                    title='Ajouter un bloc'
                    onClick={() => {
                        setFormatMenuOpen(false);
                        setAddMenuOpen((v) => !v);
                    }}
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
                            onClick={() => addBlock({ type: 'heading', text: '', level: 2 })}
                        >
                            <span className={`icon ${styles.toggleIcon} icon-heading`} /> Titre
                        </button>
                        <button
                            type='button'
                            className={styles.menuItem}
                            onClick={() => addBlock({ type: 'check', text: '', done: false })}
                        >
                            <span className={`icon ${styles.toggleIcon} icon-square-empty`} /> Case à cocher
                        </button>
                        <button
                            type='button'
                            className={styles.menuItem}
                            onClick={() => addBlock({ type: 'bullet', text: '' })}
                        >
                            <span className={`icon ${styles.toggleIcon} icon-list`} /> Liste
                        </button>
                        <button
                            type='button'
                            className={styles.menuItem}
                            onClick={() => addBlock({ type: 'number', text: '' })}
                        >
                            <span className={`icon ${styles.toggleIcon} icon-list-numbered`} /> Liste numérotée
                        </button>
                        <button type='button' className={styles.menuItem} onClick={() => addBlock({ type: 'divider' })}>
                            <span className={`icon ${styles.toggleIcon} icon-divider`} /> Séparateur
                        </button>
                    </div>
                )}
            </div>

            <div className={styles.addMenu} ref={formatMenuRef}>
                <button
                    type='button'
                    className={styles.addMenuBtn}
                    aria-label='Mettre en forme le texte'
                    aria-expanded={formatMenuOpen}
                    title='Mettre en forme la sélection'
                    onClick={() => {
                        setAddMenuOpen(false);
                        setFormatMenuOpen((v) => !v);
                    }}
                >
                    <span className={`icon ${styles.toggleIcon} icon-format`} />
                </button>
                {formatMenuOpen && (
                    <div className={`${styles.menu} ${styles.addMenuList}`}>
                        <button
                            type='button'
                            className={styles.menuItem}
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => applyMark('bold')}
                        >
                            <span className={styles.mdBold}>Gras</span>
                        </button>
                        <button
                            type='button'
                            className={styles.menuItem}
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => applyMark('italic')}
                        >
                            <span className={styles.mdItalic}>Italique</span>
                        </button>
                        <button
                            type='button'
                            className={styles.menuItem}
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => applyMark('underline')}
                        >
                            <span className={styles.mdUnderline}>Souligné</span>
                        </button>
                        <button
                            type='button'
                            className={styles.menuItem}
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => applyMark('strike')}
                        >
                            <span className={styles.mdStrike}>Barré</span>
                        </button>

                        {activeBlock?.type !== 'divider' && (
                            <>
                                <div className={styles.menuLabel}>Couleur du texte</div>
                                {swatchRow(applyColor, clearColor)}
                            </>
                        )}

                        {activeMarkerBlock && (
                            <>
                                <div className={styles.menuLabel}>{markerColorLabel(activeMarkerBlock.type)}</div>
                                {swatchRow(
                                    setBlockColor,
                                    () => setBlockColor(undefined),
                                    activeMarkerBlock.color ?? null
                                )}
                            </>
                        )}
                    </div>
                )}
            </div>
        </div>
    );

    return (
        <>
            <div
                className={`${styles.blocks} ${fill ? styles.blocksFill : ''} ${drag !== null ? styles.dragging : ''}`}
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

            {fill ? (
                <>
                    {notice}
                    <hr className={styles.divider} />
                    <div className={styles.editorFooter}>
                        <div className={styles.footerLeft}>
                            {footerActions}
                            {footerActions && <span className={styles.vsep} aria-hidden='true' />}
                            {tools}
                        </div>
                        <div className={styles.footerRight}>
                            {footerDates}
                            {footerButtons}
                        </div>
                    </div>
                </>
            ) : (
                <>
                    <div className={styles.addBar}>
                        {tools}
                        {footerDates}
                    </div>
                    {notice}
                    <hr className={styles.divider} />
                    <div className={styles.editorFooter}>
                        <div className={styles.footerLeft}>{footerActions}</div>
                        <div className={styles.footerRight}>{footerButtons}</div>
                    </div>
                </>
            )}
        </>
    );
}
