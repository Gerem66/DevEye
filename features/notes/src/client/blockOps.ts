import type { NoteBlock } from '../contracts/domain';

import type { BlockPoint, BlockRange } from './selection';

/**
 * The note body's editing primitives: pure functions from a block list (plus a
 * caret or a selection) to the next block list and where the caret lands. No DOM
 * and no React here, so the editor stays a thin layer: read the selection, call
 * one of these, commit the result.
 */

export interface Edit {
    blocks: NoteBlock[];
    caret: BlockPoint;
}

export function isEditable(block: NoteBlock): boolean {
    return block.type !== 'divider';
}

export function textOf(block: NoteBlock): string {
    return 'text' in block ? block.text : '';
}

/** Text replaced, kind and attributes (done, colour…) kept. */
function withText(block: NoteBlock, text: string): NoteBlock {
    return { ...block, text } as NoteBlock;
}

const paragraph = (text: string): NoteBlock => ({ type: 'text', text });

export function setText(blocks: NoteBlock[], index: number, text: string): NoteBlock[] {
    return blocks.map((b, i) => (i === index ? withText(b, text) : b));
}

/** What Enter creates after `b`: the same kind, except a heading yields a paragraph. */
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
 * Replace everything the selection covers with `insert`. Blocks entirely inside
 * the range vanish and the partial ends are stitched into one block, which keeps
 * the *first* one's kind; a divider the range touches is atomic, so it goes with
 * it. A collapsed range makes this a plain insertion, hence typing over a
 * selection, Ctrl+Enter and paste all land here.
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

/** Backspace at a block's very start. An atomic divider above is simply removed. */
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

/** Delete at a block's very end: the same merge, seen from the block above. */
export function mergeForward(blocks: NoteBlock[], index: number): Edit | null {
    return index < blocks.length - 1 ? mergeBackward(blocks, index + 1) : null;
}

/** The list never empties: a lone block is replaced by a blank paragraph. */
export function removeBlock(blocks: NoteBlock[], index: number): Edit {
    if (blocks.length <= 1) return { blocks: [paragraph('')], caret: { index: 0, offset: 0 } };
    const next = blocks.filter((_, i) => i !== index);
    const landing = Math.max(0, index - 1);
    return { blocks: next, caret: { index: landing, offset: textOf(next[landing]).length } };
}

/** Back to a plain paragraph, keeping the text. */
export function demote(blocks: NoteBlock[], index: number): Edit {
    return {
        blocks: blocks.map((b, i) => (i === index ? paragraph(textOf(b)) : b)),
        caret: { index, offset: 0 }
    };
}

/** `[]`, `[ ]`, `- []` or `- [ ]` at the very start of a line, space optional. */
const CHECK_TRIGGER = /^(?:- )?\[ ?\] ?/;

/** `- ` or `* ` at the very start. */
const BULLET_TRIGGER = /^[-*] /;

/** `1. ` or `1) `, any number. */
const NUMBER_TRIGGER = /^\d+[.)] /;

/** `# ` to `##### `: the heading's level is the marker's length. */
const HEADING_TRIGGER = /^(#{1,5}) /;

const DIVIDER_TRIGGER = '---';

/**
 * Convert paragraph `index` if what was just typed starts with one of the
 * markdown-ish prefixes, keeping the rest of the line and carrying the caret
 * (an offset in the *current* text) over the stripped prefix.
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
