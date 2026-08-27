import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import styles from './style.module.css';
import BlockText from './BlockText';
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
import {
    applyTrigger,
    demote,
    isEditable,
    mergeBackward,
    mergeForward,
    removeBlock,
    replaceRange,
    setText,
    splitBlock,
    textOf,
    type Edit
} from './blockOps';
import {
    applySelection,
    blockRow,
    blockTextElement,
    caretRange,
    isCollapsed,
    readSelection,
    selectionInText,
    snapCaret,
    spansBlocks,
    type BlockPoint,
    type BlockRange
} from './selection';

import type {
    NoteBlock,
    NoteBulletBlock,
    NoteCheckBlock,
    NoteColor,
    NoteDividerBlock,
    NoteNumberBlock
} from '../contracts/domain';

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

/** Keyboard shortcuts that would otherwise let the browser style the DOM itself. */
const MARK_SHORTCUTS: Record<string, InlineMark> = { b: 'bold', i: 'italic', u: 'underline' };

/** How long a run of keystrokes keeps folding into a single undo step. */
const TYPING_MERGE_MS = 700;

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
 * Heading size class for a block. `level` is 1–5 per the note schema but typed
 * as a plain `number`, so it can't index the stylesheet directly.
 */
function headingClass(level: number): string {
    const classes = [styles.heading1, styles.heading2, styles.heading3, styles.heading4, styles.heading5];
    return classes[level - 1] ?? styles.heading1;
}

interface DragState {
    /** Original index of the row being dragged. */
    from: number;
    /** Insertion position among the *remaining* rows (0..length-1): where the
     *  dragged row would land if dropped now. */
    to: number;
    /** Add to `clientY` to get the dragged row's vertical centre, so the switch
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

/** A state the editor can go back to: the blocks, and where the user was. */
interface Snapshot {
    blocks: NoteBlock[];
    selection: BlockRange | null;
}

/**
 * The modular note body: an ordered list of typed blocks (paragraph, heading,
 * checklist / list item, divider), rendered inside **one** contentEditable host.
 *
 * That single host is the whole design. The caret and a selection move over the
 * list exactly as they would over a plain document, within a wrapped line, from
 * one block to the next, across several of them, so navigation, selection and
 * copy are the browser's, not ours. What the browser cannot be trusted with is
 * *structure*: an edit reaching across blocks would merge the elements
 * themselves and desynchronise the model. Those are intercepted and replayed on
 * the model instead (see {@link blockOps}):
 *  - Enter splits the block at the caret into a sibling of the same kind (a
 *    heading yields a paragraph); Ctrl/⌘+Enter and Shift+Enter insert a line
 *    break in place.
 *  - Backspace at the start of a typed item / heading demotes it to a paragraph,
 *    then merges it into the block above; Delete at the end pulls the next one in.
 *  - Anything typed, pasted or deleted over a multi-block selection stitches the
 *    partial ends into a single block.
 *  - Start-of-line prefixes convert a paragraph: `[]` → checklist, `- ` → bullet,
 *    `1. ` → numbered, `# `…`##### ` → heading, a lone `---` → divider.
 *
 * Undo/redo is ours too: the blocks are re-rendered from the model, which wipes
 * the browser's own edit history, so every change is committed through
 * {@link commit} with the previous state pushed on a stack (runs of keystrokes
 * folding into one step).
 *
 * Inline emphasis (bold/italic/underline/strike) is typed as markdown markers
 * and rendered live by {@link BlockText}; Ctrl+B/I/U and the "Aa" menu wrap the
 * selection. New blocks are added through the discreet "+" menu.
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
    const rootRef = useRef<HTMLDivElement>(null);
    /** The last selection seen inside the list. Kept because clicking a menu
     *  button moves focus out, yet the format tools act on what was selected. */
    const selectionRef = useRef<BlockRange | null>(null);
    /** Where the selection must land once the pending change has rendered. */
    const pending = useRef<BlockRange | null>(null);
    const past = useRef<Snapshot[]>([]);
    const future = useRef<Snapshot[]>([]);
    /** Until when consecutive typing keeps folding into the same undo step. */
    const coalesceUntil = useRef(0);
    /** The last list this editor produced; anything else came from the outside
     *  (another note opened), which makes the history moot. */
    const owned = useRef(blocks);
    /** The block the format menu targets, where the caret is, or a divider the
     *  user clicked. Drives the contextual colour picker. */
    const [active, setActive] = useState<number | null>(null);
    const [drag, setDrag] = useState<DragState | null>(null);
    const [addMenuOpen, setAddMenuOpen] = useState(false);
    const [formatMenuOpen, setFormatMenuOpen] = useState(false);
    const addMenuRef = useRef<HTMLDivElement | null>(null);
    const formatMenuRef = useRef<HTMLDivElement | null>(null);

    // A list this editor did not produce means another note was opened: its
    // history is not ours to undo.
    useEffect(() => {
        if (blocks === owned.current) return;
        owned.current = blocks;
        past.current = [];
        future.current = [];
        coalesceUntil.current = 0;
    });

    // Restore the selection a change asked for, once that change has rendered
    // (the blocks' own HTML is written in their layout effect, i.e. before this).
    useLayoutEffect(() => {
        const root = rootRef.current;
        const target = pending.current;
        pending.current = null;
        if (!root || !target) return;
        root.focus({ preventScroll: true });
        applySelection(root, target);
        selectionRef.current = target;
        setActive(target.start.index);
    });

    // Follow the caret wherever it goes, keeping it out of the rows' chrome,
    // so the format menu stays contextual.
    useEffect(() => {
        const onSelectionChange = () => {
            const root = rootRef.current;
            const selection = root && (snapCaret(root) ?? readSelection(root));
            if (!selection) return;
            selectionRef.current = selection;
            setActive(selection.start.index);
        };
        document.addEventListener('selectionchange', onSelectionChange);
        return () => document.removeEventListener('selectionchange', onSelectionChange);
    }, []);

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

    /** Hand `next` to the parent, remembering where the selection must land
     *  (null leaves it wherever it is). */
    const apply = useCallback(
        (next: NoteBlock[], caret: BlockPoint | BlockRange | null) => {
            owned.current = next;
            pending.current = caret === null ? null : 'index' in caret ? caretRange(caret) : caret;
            onChange(next);
        },
        [onChange]
    );

    /** Apply a change and make it undoable. `typing` folds a run of keystrokes
     *  into the step already on the stack, so undo goes back by words, not
     *  characters. */
    const commit = useCallback(
        (next: NoteBlock[], caret: BlockPoint | BlockRange | null, typing = false) => {
            const now = Date.now();
            if (!typing || now > coalesceUntil.current) {
                past.current.push({ blocks, selection: selectionRef.current });
                future.current = [];
            }
            coalesceUntil.current = typing ? now + TYPING_MERGE_MS : 0;
            apply(next, caret);
        },
        [blocks, apply]
    );

    const commitEdit = useCallback((edit: Edit, typing = false) => commit(edit.blocks, edit.caret, typing), [commit]);

    /** Pop one state off `from`, pushing the current one onto `to`. */
    const travel = useCallback(
        (from: Snapshot[], to: Snapshot[]) => {
            const snapshot = from.pop();
            if (!snapshot) return;
            to.push({ blocks, selection: selectionRef.current });
            coalesceUntil.current = 0;
            apply(snapshot.blocks, snapshot.selection);
        },
        [blocks, apply]
    );

    const undo = useCallback(() => travel(past.current, future.current), [travel]);
    const redo = useCallback(() => travel(future.current, past.current), [travel]);

    const update = useCallback(
        (index: number, patch: Partial<NoteBlock>) => {
            commit(
                blocks.map((b, i) => (i === index ? ({ ...b, ...patch } as NoteBlock) : b)),
                null
            );
        },
        [blocks, commit]
    );

    const toggleDone = useCallback(
        (index: number) => {
            const b = blocks[index];
            if (b.type !== 'check') return;
            update(index, { done: !b.done });
        },
        [blocks, update]
    );

    /**
     * Pull the model back in line with the DOM after an edit the browser was
     * left to make. Only text can have changed, everything structural was
     * intercepted before it happened, so the blocks' surfaces are read back and
     * the ones that moved are committed. Reading them all rather than the one
     * under the caret costs a handful of microseconds and cannot drift.
     */
    const onInput = useCallback(() => {
        const root = rootRef.current;
        if (!root) return;
        const next = blocks.map((b, i) => {
            if (!isEditable(b)) return b;
            const text = blockTextElement(root, i)?.textContent ?? textOf(b);
            return text === textOf(b) ? b : ({ ...b, text } as NoteBlock);
        });
        const changed = next.findIndex((b, i) => b !== blocks[i]);
        if (changed === -1) return;
        const selection = readSelection(root);
        const converted = selection && applyTrigger(next, changed, selection.start.offset);
        if (converted) commitEdit(converted);
        else commit(next, selection, true);
    }, [blocks, commit, commitEdit]);

    /**
     * The browser may only edit *inside* a block. Anything reaching across two
     * of them, typing or deleting over a multi-block selection, is replayed on
     * the model, as is its own undo (whose stack our re-rendering has wiped) and
     * its own styling commands (which would inject tags into the source text).
     *
     * Listened to natively: React's `onBeforeInput` is a legacy polyfill built
     * on keypress/textInput, which knows neither `inputType` nor deletions.
     */
    useEffect(() => {
        const root = rootRef.current;
        if (!root) return;
        const onBeforeInput = (e: InputEvent) => {
            const { inputType, data } = e;
            if (inputType === 'historyUndo' || inputType === 'historyRedo') {
                e.preventDefault();
                if (inputType === 'historyUndo') undo();
                else redo();
                return;
            }
            if (inputType.startsWith('format')) {
                e.preventDefault();
                return;
            }
            // Left to the browser only within one block's text; from anywhere
            // else (across blocks, or from a caret beside a row's chrome) the
            // edit is replayed on the model at the position it maps to.
            const selection = readSelection(root);
            if (!selection || (!spansBlocks(selection) && selectionInText(root))) return;
            e.preventDefault();
            commitEdit(replaceRange(blocks, selection, data ?? ''), inputType === 'insertText');
        };
        root.addEventListener('beforeinput', onBeforeInput);
        return () => root.removeEventListener('beforeinput', onBeforeInput);
    }, [blocks, commitEdit, undo, redo]);

    /** Wrap the current selection (or insert an empty pair) with a mark. */
    const applyMark = useCallback(
        (mark: InlineMark) => {
            setFormatMenuOpen(false);
            const selection = selectionRef.current;
            if (!selection || spansBlocks(selection)) return;
            const index = selection.start.index;
            const b = blocks[index];
            if (!b || !isEditable(b)) return;
            const { offset: start } = selection.start;
            const { offset: end } = selection.end;
            const delim = MARK_DELIMITERS[mark];
            const text = textOf(b);
            const wrapped = text.slice(0, start) + delim + text.slice(start, end) + delim + text.slice(end);
            // An empty selection drops the caret between the markers, so what is
            // typed next is marked; a real one keeps hold of the wrapped text.
            const caret = start === end ? start + delim.length : end + 2 * delim.length;
            commit(setText(blocks, index, wrapped), { index, offset: caret });
        },
        [blocks, commit]
    );

    /** Colour the current selection (wrap in `{c:…}{/c}`), mirroring applyMark. */
    const applyColor = useCallback(
        (color: NoteColor) => {
            setFormatMenuOpen(false);
            const selection = selectionRef.current;
            if (!selection || spansBlocks(selection)) return;
            const index = selection.start.index;
            const b = blocks[index];
            if (!b || !isEditable(b)) return;
            const { offset: start } = selection.start;
            const { offset: end } = selection.end;
            const open = colorOpen(color);
            const text = textOf(b);
            const wrapped = text.slice(0, start) + open + text.slice(start, end) + COLOR_CLOSE + text.slice(end);
            commit(setText(blocks, index, wrapped), { index, offset: (start === end ? start : end) + open.length });
        },
        [blocks, commit]
    );

    /** Clear text colour: strip colour markers within the selection, or, with a
     *  collapsed caret, from the coloured run under it. */
    const clearColor = useCallback(() => {
        setFormatMenuOpen(false);
        const selection = selectionRef.current;
        if (!selection || spansBlocks(selection)) return;
        const index = selection.start.index;
        const b = blocks[index];
        if (!b || !isEditable(b)) return;
        const { offset: start } = selection.start;
        const { offset: end } = selection.end;
        const text = textOf(b);
        if (start !== end) {
            const inner = stripColorMarkers(text.slice(start, end));
            commit(setText(blocks, index, text.slice(0, start) + inner + text.slice(end)), {
                index,
                offset: start + inner.length
            });
            return;
        }
        const cleared = removeEnclosingColor(text, start);
        if (cleared) commit(setText(blocks, index, cleared.text), { index, offset: cleared.caret });
    }, [blocks, commit]);

    /** Set (or clear, with `undefined`) the marker colour of the active marker
     *  block, the bullet dot, ordinal, checkbox or divider rule. */
    const setBlockColor = useCallback(
        (color: NoteColor | undefined) => {
            setFormatMenuOpen(false);
            if (active === null) return;
            const b = blocks[active];
            if (!b || !MARKER_TYPES.has(b.type)) return;
            commit(
                blocks.map((bb, i) => (i === active ? ({ ...bb, color } as NoteBlock) : bb)),
                null
            );
        },
        [active, blocks, commit]
    );

    const addBlock = useCallback(
        (block: NoteBlock) => {
            setAddMenuOpen(false);
            commit([...blocks, block], { index: blocks.length, offset: 0 });
        },
        [blocks, commit]
    );

    const onKeyDown = useCallback(
        (e: React.KeyboardEvent<HTMLDivElement>) => {
            const root = rootRef.current;
            if (!root) return;
            const mod = e.ctrlKey || e.metaKey;
            const key = e.key.toLowerCase();

            if (mod && key === 'z') {
                e.preventDefault();
                if (e.shiftKey) redo();
                else undo();
                return;
            }
            if (mod && key === 'y') {
                e.preventDefault();
                redo();
                return;
            }
            // Keys pressed on a row's own buttons (grip, checkbox, delete) are
            // theirs: only a caret in the text calls for block editing.
            if (document.activeElement !== root) return;
            if (mod && MARK_SHORTCUTS[key]) {
                e.preventDefault();
                applyMark(MARK_SHORTCUTS[key]);
                return;
            }

            const selection = readSelection(root);
            if (!selection) return;
            const { index, offset } = selection.start;
            const block = blocks[index];

            if (e.key === 'Enter') {
                e.preventDefault();
                // Ctrl/⌘+Enter and Shift+Enter are a line break in place; plain
                // Enter splits the block. Either way what the selection covered
                // goes first.
                const lineBreak = mod || e.shiftKey;
                const cleared = replaceRange(blocks, selection, lineBreak ? '\n' : '');
                commitEdit(lineBreak ? cleared : splitBlock(cleared.blocks, cleared.caret));
                return;
            }

            if (e.key !== 'Backspace' && e.key !== 'Delete') return;

            if (!isCollapsed(selection)) {
                // Within one block the browser deletes correctly by itself.
                if (!spansBlocks(selection)) return;
                e.preventDefault();
                commitEdit(replaceRange(blocks, selection, ''));
                return;
            }
            if (e.key === 'Backspace' && offset === 0) {
                e.preventDefault();
                // A typed item / heading first falls back to a plain paragraph,
                // keeping its text; only then does it join the block above.
                if (isEditable(block) && block.type !== 'text') {
                    commitEdit(demote(blocks, index));
                    return;
                }
                const merged = mergeBackward(blocks, index);
                if (merged) commitEdit(merged);
                return;
            }
            if (e.key === 'Delete' && offset === textOf(block).length) {
                e.preventDefault();
                const merged = mergeForward(blocks, index);
                if (merged) commitEdit(merged);
            }
        },
        [blocks, commitEdit, applyMark, undo, redo]
    );

    /** Paste as plain text: line breaks stay line breaks (as Ctrl+Enter makes
     *  them), and no foreign markup ever reaches a block's source. */
    const onPaste = useCallback(
        (e: React.ClipboardEvent<HTMLDivElement>) => {
            const root = rootRef.current;
            const selection = root && readSelection(root);
            if (!selection) return;
            e.preventDefault();
            commitEdit(replaceRange(blocks, selection, e.clipboardData.getData('text/plain')));
        },
        [blocks, commitEdit]
    );

    /** Cutting across blocks is a copy plus a model-level delete, the browser's
     *  own would take the block elements with it. */
    const onCut = useCallback(
        (e: React.ClipboardEvent<HTMLDivElement>) => {
            const root = rootRef.current;
            const selection = root && readSelection(root);
            if (!selection || !spansBlocks(selection)) return;
            e.preventDefault();
            e.clipboardData.setData('text/plain', window.getSelection()?.toString() ?? '');
            commitEdit(replaceRange(blocks, selection, ''));
        },
        [blocks, commitEdit]
    );

    const onGripDragStart = useCallback(
        (e: React.DragEvent, index: number) => {
            const root = rootRef.current;
            const row = root && blockRow(root, index);
            if (!root || !row) return;
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
                const r = blockRow(root, i)?.getBoundingClientRect();
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
            // Block the browser's native drop handling: dropping over the editable
            // surface would otherwise insert the drag's text/plain payload (the
            // row index) straight into the text.
            e.preventDefault();
            setDrag((d) => {
                if (d && d.to !== d.from) {
                    const next = blocks.filter((_, i) => i !== d.from);
                    next.splice(d.to, 0, blocks[d.from]);
                    commit(next, null);
                }
                return null;
            });
        },
        [blocks, commit]
    );

    // Render order, with the placeholder injected among the remaining rows.
    // `placeholderBefore` is the original index the gap sits before, or -1 for
    // "after the last row".
    const remaining = drag === null ? [] : blocks.map((_, i) => i).filter((i) => i !== drag.from);
    const placeholderBefore = drag === null ? null : drag.to < remaining.length ? remaining[drag.to] : -1;

    // Display index of each numbered item, restarting at 1 after any non-number
    // block, so consecutive numbered rows read 1, 2, 3… and stay coherent.
    const numbering: number[] = [];
    let run = 0;
    for (let i = 0; i < blocks.length; i++) {
        run = blocks[i].type === 'number' ? run + 1 : 0;
        numbering[i] = run;
    }

    // Everything that isn't the block's own text is chrome: kept out of the
    // editing host so the caret never lands in it and a selection never drags it
    // along (`contentEditable={false}` plus `user-select: none` in the CSS).
    const renderRow = (block: NoteBlock, index: number) => (
        <div
            key={index}
            data-block={index}
            className={`${styles.block} ${drag?.from === index ? styles.blockHidden : ''}`}
        >
            <button
                type='button'
                contentEditable={false}
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
                    contentEditable={false}
                    className={`${styles.checkButton} ${block.done ? styles.checkButtonDone : ''}`}
                    style={block.color ? { color: colorVar(block.color) } : undefined}
                    aria-label={block.done ? 'Décocher' : 'Cocher'}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => toggleDone(index)}
                >
                    <span className={`icon ${styles.badge} icon-${block.done ? 'square-check' : 'square-empty'}`} />
                </button>
            )}
            {block.type === 'bullet' && (
                <span
                    contentEditable={false}
                    className={styles.blockBullet}
                    style={block.color ? { background: colorVar(block.color) } : undefined}
                    aria-hidden='true'
                />
            )}
            {block.type === 'number' && (
                <span
                    contentEditable={false}
                    className={styles.blockNumber}
                    style={block.color ? { color: colorVar(block.color) } : undefined}
                    aria-hidden='true'
                >
                    {numbering[index]}.
                </span>
            )}
            {block.type === 'divider' ? (
                <div
                    contentEditable={false}
                    className={`${styles.dividerHit} ${active === index ? styles.dividerSelected : ''}`}
                    role='separator'
                    title='Cliquer pour le sélectionner, puis choisir sa couleur dans le menu de mise en forme'
                    onMouseDown={(e) => {
                        // Keep the caret where it was: the rule is a target for
                        // the format menu, not a place to type.
                        e.preventDefault();
                        selectionRef.current = null;
                        setActive(index);
                    }}
                >
                    <div
                        className={styles.dividerLine}
                        style={block.color ? { borderTopColor: colorVar(block.color) } : undefined}
                    />
                </div>
            ) : (
                <BlockText
                    className={`${styles.blockText} ${block.type === 'heading' ? headingClass(block.level) : ''} ${
                        block.type === 'check' && block.done ? styles.blockTextDone : ''
                    }`}
                    value={block.text}
                    placeholder={block.type === 'text' ? 'Écrivez quelque chose…' : 'Élément…'}
                />
            )}
            {blocks.length > 1 && (
                <button
                    type='button'
                    contentEditable={false}
                    className={styles.blockRemove}
                    aria-label='Supprimer la ligne'
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => commitEdit(removeBlock(blocks, index))}
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
                <div className={styles.blockGhost} contentEditable={false} aria-hidden='true'>
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

    // The block currently targeted by the format menu, and, when it carries a
    // colourable marker, that block, so the menu can offer its marker picker.
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

    // The "+" (add block) and "Aa" (format) tools, placed in the footer when the
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
                ref={rootRef}
                className={`${styles.blocks} ${fill ? styles.blocksFill : ''} ${drag !== null ? styles.dragging : ''}`}
                contentEditable
                suppressContentEditableWarning
                role='textbox'
                aria-multiline='true'
                aria-label='Contenu de la note'
                onInput={onInput}
                onKeyDown={onKeyDown}
                onPaste={onPaste}
                onCut={onCut}
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
