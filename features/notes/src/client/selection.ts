/**
 * Bridge between the DOM selection and the block model.
 *
 * The whole block list is a *single* contentEditable host (see BlockEditor), so a
 * selection may span several blocks. Every row carries `data-block="<index>"` and,
 * when it holds text, a `[data-text]` surface whose rendered content equals the
 * block's source character-for-character (see {@link inlineToEditorHtml}): a DOM
 * boundary therefore maps to a plain-text offset inside a block, and back.
 */

/** A caret position in the model: a block index + a plain-text offset. */
export interface BlockPoint {
    index: number;
    offset: number;
}

/** A selection in the model, always in document order. */
export interface BlockRange {
    start: BlockPoint;
    end: BlockPoint;
}

export const caretRange = (point: BlockPoint): BlockRange => ({ start: point, end: point });

/** The case the browser can't be trusted with: it would merge the rows themselves. */
export const spansBlocks = (range: BlockRange): boolean => range.start.index !== range.end.index;

export const isCollapsed = (range: BlockRange): boolean =>
    range.start.index === range.end.index && range.start.offset === range.end.offset;

/** Decides where a boundary falling between blocks, or beside a row's chrome, sticks. */
type Edge = 'start' | 'end';

function asElement(node: Node | null): Element | null {
    if (!node) return null;
    return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
}

function rowOf(node: Node | null): HTMLElement | null {
    return asElement(node)?.closest<HTMLElement>('[data-block]') ?? null;
}

/** The text surface `node` lives in, null when it sits in a row's chrome. */
function textSurfaceOf(node: Node | null): HTMLElement | null {
    return asElement(node)?.closest<HTMLElement>('[data-text]') ?? null;
}

export function blockRow(root: HTMLElement, index: number): HTMLElement | null {
    return root.querySelector<HTMLElement>(`[data-block="${index}"]`);
}

/** A block's text surface (null for a divider, which holds none). */
export function blockTextElement(root: HTMLElement, index: number): HTMLElement | null {
    return blockRow(root, index)?.querySelector<HTMLElement>('[data-text]') ?? null;
}

/** Plain-text offset of the position `node`/`nodeOffset` within `root`. */
function offsetWithin(root: HTMLElement, node: Node, nodeOffset: number): number {
    const range = document.createRange();
    range.selectNodeContents(root);
    range.setEnd(node, nodeOffset);
    return range.toString().length;
}

/** Resolve a plain-text offset back to a (text node, offset) pair inside `root`. */
function locate(root: HTMLElement, target: number): { node: Node; offset: number } {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let remaining = target;
    let last: Node = root;
    let node = walker.nextNode();
    while (node) {
        const len = node.textContent?.length ?? 0;
        if (remaining <= len) return { node, offset: remaining };
        remaining -= len;
        last = node;
        node = walker.nextNode();
    }
    return { node: last, offset: last.textContent?.length ?? 0 };
}

/** A boundary that owns the whole row: `start` clings to its beginning, `end` to its end. */
function edgePoint(row: HTMLElement, edge: Edge): BlockPoint {
    const text = row.querySelector<HTMLElement>('[data-text]');
    return {
        index: Number(row.dataset.block),
        offset: edge === 'start' ? 0 : (text?.textContent?.length ?? 0)
    };
}

/** The model position of a DOM boundary, or null when it lies outside the list. */
function pointFrom(root: HTMLElement, node: Node, nodeOffset: number, edge: Edge): BlockPoint | null {
    let row = rowOf(node);
    if (!row) {
        // A boundary at container level (select-all, or a drag past the list):
        // walk from the child it points at, towards the first real row.
        const children = Array.from(root.childNodes);
        const step = edge === 'start' ? 1 : -1;
        for (let i = edge === 'start' ? nodeOffset : nodeOffset - 1; i >= 0 && i < children.length; i += step) {
            row = rowOf(children[i]);
            if (row) break;
        }
        return row ? edgePoint(row, edge) : null;
    }
    const text = row.querySelector<HTMLElement>('[data-text]');
    // Beside the row's chrome (or on a divider) there is no offset to read.
    if (!text || !text.contains(node)) return edgePoint(row, edge);
    return { index: Number(row.dataset.block), offset: offsetWithin(text, node, nodeOffset) };
}

/** The current selection in model coordinates, or null when it isn't in `root`. */
export function readSelection(root: HTMLElement): BlockRange | null {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) return null;
    const start = pointFrom(root, range.startContainer, range.startOffset, 'start');
    const end = range.collapsed ? start : pointFrom(root, range.endContainer, range.endOffset, 'end');
    return start && end ? { start, end } : null;
}

/** Blocks' text is the only place the browser may be left to edit on its own. */
export function selectionInText(root: HTMLElement): boolean {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return false;
    const range = selection.getRangeAt(0);
    return (
        root.contains(range.commonAncestorContainer) &&
        textSurfaceOf(range.startContainer) !== null &&
        textSurfaceOf(range.endContainer) !== null
    );
}

/** First row from `index` that holds text: its start walking forward, its end backward. */
function nearestCaret(root: HTMLElement, index: number, dir: 1 | -1): BlockPoint | null {
    for (let i = index; i >= 0 && blockRow(root, i); i += dir) {
        const text = blockTextElement(root, i);
        if (text) return { index: i, offset: dir === 1 ? 0 : (text.textContent?.length ?? 0) };
    }
    return null;
}

/**
 * Move the caret out of the positions the browser offers *beside* a row's chrome:
 * they belong to no block, so typing there writes outside the model and a
 * backspace eats the grip or the marker. The caret is nudged the way it was
 * heading, and null means there was nothing to correct.
 */
export function snapCaret(root: HTMLElement): BlockRange | null {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    if (!range.collapsed || !root.contains(range.commonAncestorContainer)) return null;
    if (textSurfaceOf(range.startContainer)) return null;
    const row = rowOf(range.startContainer);
    if (!row) return null;

    const index = Number(row.dataset.block);
    const text = blockTextElement(root, index);
    // Which side of the row's own text the caret came to rest on (a divider has
    // none: treat it as before, so the caret carries on the way it came).
    const after = text !== null && range.comparePoint(text, 0) < 0;
    const target =
        nearestCaret(root, after ? index + 1 : index - 1, after ? 1 : -1) ??
        (text ? { index, offset: after ? (text.textContent?.length ?? 0) : 0 } : null);
    if (!target) return null;
    const snapped = caretRange(target);
    applySelection(root, snapped);
    return snapped;
}

function domPoint(root: HTMLElement, point: BlockPoint): { node: Node; offset: number } | null {
    const row = blockRow(root, point.index);
    if (!row) return null;
    const text = row.querySelector<HTMLElement>('[data-text]');
    return text ? locate(text, Math.max(0, point.offset)) : { node: row, offset: 0 };
}

export function applySelection(root: HTMLElement, range: BlockRange): void {
    const a = domPoint(root, range.start);
    const b = isCollapsed(range) ? a : domPoint(root, range.end);
    const selection = window.getSelection();
    if (!a || !b || !selection) return;
    const dom = document.createRange();
    dom.setStart(a.node, a.offset);
    dom.setEnd(b.node, b.offset);
    selection.removeAllRanges();
    selection.addRange(dom);
    blockRow(root, range.start.index)?.scrollIntoView({ block: 'nearest' });
}
