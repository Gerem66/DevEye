import type { NoteBlock } from 'deveye-types';

import type { BlockPoint, BlockRange } from './selection';

/**
 * The note body's editing primitives: pure functions from a block list (plus a
 * caret or a selection) to the next block list and where the caret lands.
 *
 * Keeping them here — free of DOM and of React — is what lets the editor stay a
 * thin layer: read the selection, call one of these, commit the result. It is
 * also what makes undo trivial, since every edit produces a fresh list.
 */

/** The outcome of an edit: the new blocks and the caret that follows them. */
export interface Edit {
    blocks: NoteBlock[];
    caret: BlockPoint;
}

/** Whether a block kind carries editable text (i.e. renders a text surface). */
export function isEditable(block: NoteBlock): boolean {
    return block.type !== 'divider';
}

export function textOf(block: NoteBlock): string {
    return 'text' in block ? block.text : '';
}

/** A block's text replaced, its kind and attributes (done, colour…) preserved.
 *  Only meaningful for editable blocks — a divider carries no text. */
function withText(block: NoteBlock, text: string): NoteBlock {
    return { ...block, text } as NoteBlock;
}

const paragraph = (text: string): NoteBlock => ({ type: 'text', text });

/** `blocks` with block `index`'s text replaced. */
export function setText(blocks: NoteBlock[], index: number, text: string): NoteBlock[] {
    return blocks.map((b, i) => (i === index ? withText(b, text) : b));
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
            return paragraph(text);
    }
}

/**
 * Replace everything the selection covers with `insert`.
 *
 * Blocks entirely inside the range vanish; the partial ends are stitched into a
 * single block that keeps the *first* one's kind — select from mid-A through
 * mid-D and what remains is A's head followed by D's tail, still an A. A divider
 * touched by such a range is atomic, so it goes with it.
 *
 * A collapsed range makes this a plain insertion, which is why the same function
 * serves typing over a selection, Ctrl+Enter and paste.
 */
export function replaceRange(blocks: NoteBlock[], range: BlockRange, insert: string): Edit {
    const { start, end } = range;
    const head = blocks[start.index];
    const tail = blocks[end.index];
    const before = isEditable(head) ? textOf(head).slice(0, start.offset) : '';
    const after = isEditable(tail) ? textOf(tail).slice(end.offset) : '';
    const survivor = isEditable(head) ? head : isEditable(tail) ? tail : paragraph('');
    const merged = withText(survivor, before + insert + after);
    return {
        blocks: [...blocks.slice(0, start.index), merged, ...blocks.slice(end.index + 1)],
        caret: { index: start.index, offset: (before + insert).length }
    };
}

/** Split a block at the caret into a sibling of the same kind (Enter). */
export function splitBlock(blocks: NoteBlock[], point: BlockPoint): Edit {
    const block = blocks[point.index];
    const text = textOf(block);
    const head = withText(block, text.slice(0, point.offset));
    const tail = siblingBlock(block, text.slice(point.offset));
    return {
        blocks: [...blocks.slice(0, point.index), head, tail, ...blocks.slice(point.index + 1)],
        caret: { index: point.index + 1, offset: 0 }
    };
}

/** Pull block `index` into the one above (Backspace at its very start): the
 *  inverse of {@link splitBlock}. An atomic divider above is simply removed. */
export function mergeBackward(blocks: NoteBlock[], index: number): Edit | null {
    if (index <= 0) return null;
    const previous = blocks[index - 1];
    if (!isEditable(previous)) {
        return {
            blocks: blocks.filter((_, i) => i !== index - 1),
            caret: { index: index - 1, offset: 0 }
        };
    }
    const kept = textOf(previous);
    return {
        blocks: [
            ...blocks.slice(0, index - 1),
            withText(previous, kept + textOf(blocks[index])),
            ...blocks.slice(index + 1)
        ],
        caret: { index: index - 1, offset: kept.length }
    };
}

/** Pull the next block into this one (Delete at its very end) — the same merge,
 *  seen from the block above. */
export function mergeForward(blocks: NoteBlock[], index: number): Edit | null {
    return index < blocks.length - 1 ? mergeBackward(blocks, index + 1) : null;
}

/** Drop a block entirely (the row's delete button), landing on the previous one.
 *  The list never empties: a lone block is replaced by a blank paragraph. */
export function removeBlock(blocks: NoteBlock[], index: number): Edit {
    if (blocks.length <= 1) return { blocks: [paragraph('')], caret: { index: 0, offset: 0 } };
    const next = blocks.filter((_, i) => i !== index);
    const landing = Math.max(0, index - 1);
    return { blocks: next, caret: { index: landing, offset: textOf(next[landing]).length } };
}

/** Turn a typed item / heading back into a plain paragraph, keeping its text. */
export function demote(blocks: NoteBlock[], index: number): Edit {
    return {
        blocks: blocks.map((b, i) => (i === index ? paragraph(textOf(b)) : b)),
        caret: { index, offset: 0 }
    };
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

/**
 * Convert paragraph `index` if what was just typed starts with one of the
 * markdown-ish prefixes, keeping the rest of the line and carrying the caret
 * (given as an offset in the *current* text) over the stripped prefix.
 * Null when nothing matches, which is the common case.
 */
export function applyTrigger(blocks: NoteBlock[], index: number, offset: number): Edit | null {
    const block = blocks[index];
    if (block.type !== 'text') return null;
    const value = block.text;

    const convert = (converted: NoteBlock, prefix: string): Edit => ({
        blocks: blocks.map((b, i) => (i === index ? converted : b)),
        caret: { index, offset: Math.max(0, offset - prefix.length) }
    });

    const check = CHECK_TRIGGER.exec(value);
    if (check) return convert({ type: 'check', text: value.slice(check[0].length), done: false }, check[0]);

    const bullet = BULLET_TRIGGER.exec(value);
    if (bullet) return convert({ type: 'bullet', text: value.slice(bullet[0].length) }, bullet[0]);

    const number = NUMBER_TRIGGER.exec(value);
    if (number) return convert({ type: 'number', text: value.slice(number[0].length) }, number[0]);

    const heading = HEADING_TRIGGER.exec(value);
    if (heading) {
        return convert({ type: 'heading', text: value.slice(heading[0].length), level: heading[1].length }, heading[0]);
    }

    if (value === DIVIDER_TRIGGER) {
        // The rule replaces the paragraph, and a blank one below it takes the caret.
        return {
            blocks: [...blocks.slice(0, index), { type: 'divider' }, paragraph(''), ...blocks.slice(index + 1)],
            caret: { index: index + 1, offset: 0 }
        };
    }
    return null;
}
