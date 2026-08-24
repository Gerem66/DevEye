import { noteColorSchema, type NoteColor } from '@deveye/types';

/**
 * Tiny inline-markdown engine shared by the note editor (live rendering), the
 * card preview (markers stripped) and the PDF export (semantic HTML).
 *
 * Supported inline marks, kept as markers inside a block's plain text:
 *  - `**bold**`        → bold
 *  - `*italic*`        → italic
 *  - `__underline__`   → underline
 *  - `~~strike~~`      → strikethrough
 *  - `{c:red}…{/c}`    → coloured text (name ∈ noteColorSchema); rendered with
 *    the `--note-<name>` theme token. Unlike the emphasis marks it carries a
 *    parameter (the colour) and nests properly (recolouring a sub-range works),
 *    so it is matched with an explicit open/close + depth count.
 *
 * Marks nest (e.g. `**bold _und_**`); overlapping ranges aren't supported (no
 * standard markdown is). Two-char delimiters are matched before the single `*`,
 * and `_` only forms underline as a pair so it never clashes with snake_case.
 */

export type InlineMark = 'bold' | 'italic' | 'underline' | 'strike';

type InlineNode =
    | { type: 'text'; text: string }
    | { type: 'mark'; mark: InlineMark; delim: string; children: InlineNode[] }
    | { type: 'color'; color: NoteColor; children: InlineNode[] };

const DELIMITERS: { delim: string; mark: InlineMark }[] = [
    { delim: '**', mark: 'bold' },
    { delim: '__', mark: 'underline' },
    { delim: '~~', mark: 'strike' },
    { delim: '*', mark: 'italic' }
];

/** The markdown markers, longest first — used to wrap a selection from the toolbar. */
export const MARK_DELIMITERS: Record<InlineMark, string> = {
    bold: '**',
    underline: '__',
    strike: '~~',
    italic: '*'
};

/** Colour marker builders (kept next to the parser so both stay in sync). */
export const COLOR_CLOSE = '{/c}';
export const colorOpen = (color: NoteColor): string => `{c:${color}}`;

const VALID_COLORS = new Set<string>(noteColorSchema.options);
const COLOR_OPEN_RE = /^\{c:([a-z]+)\}/;

/** Remove every `{c:name}`/`{/c}` marker from a string (used to clear colour). */
export function stripColorMarkers(input: string): string {
    return input
        .replace(/\{c:([a-z]+)\}/g, (m, name: string) => (VALID_COLORS.has(name) ? '' : m))
        .replace(/\{\/c\}/g, '');
}

/**
 * Strip the (innermost) colour pair whose content encloses caret `pos`, if any,
 * returning the new text and the caret shifted for the removed opening marker.
 * Null when the caret isn't inside a coloured run — lets "Défaut" clear the
 * colour of the run under a collapsed caret without touching anything else.
 */
export function removeEnclosingColor(input: string, pos: number): { text: string; caret: number } | null {
    let best: { openStart: number; openLen: number; closeStart: number } | null = null;
    let i = 0;
    while (i < input.length) {
        const open = COLOR_OPEN_RE.exec(input.slice(i));
        if (open && VALID_COLORS.has(open[1])) {
            const innerStart = i + open[0].length;
            const closeStart = findColorClose(input, innerStart);
            // Enclosing when the caret sits within the inner range; keep the
            // innermost (largest opening index).
            if (closeStart !== -1 && innerStart <= pos && pos <= closeStart) {
                best = { openStart: i, openLen: open[0].length, closeStart };
            }
            i = innerStart; // descend so nested opens are considered too
            continue;
        }
        i++;
    }
    if (!best) return null;
    // Remove the close first (higher index), then the open, so indices hold.
    let text = input.slice(0, best.closeStart) + input.slice(best.closeStart + COLOR_CLOSE.length);
    text = text.slice(0, best.openStart) + text.slice(best.openStart + best.openLen);
    return { text, caret: Math.max(0, pos - best.openLen) };
}

/**
 * Index of the `{/c}` that closes a colour opened just before `from`, honouring
 * nested colour pairs (depth count); -1 if unbalanced. Only valid `{c:name}`
 * count as nested opens, so stray text with braces doesn't skew the balance.
 */
function findColorClose(input: string, from: number): number {
    let depth = 1;
    let k = from;
    while (k < input.length) {
        if (input.startsWith(COLOR_CLOSE, k)) {
            depth--;
            if (depth === 0) return k;
            k += COLOR_CLOSE.length;
            continue;
        }
        const open = COLOR_OPEN_RE.exec(input.slice(k));
        if (open && VALID_COLORS.has(open[1])) {
            depth++;
            k += open[0].length;
            continue;
        }
        k++;
    }
    return -1;
}

/** Parse a single line/segment of inline markdown into a node tree. */
function parseInline(input: string): InlineNode[] {
    const out: InlineNode[] = [];
    let i = 0;
    const pushText = (ch: string) => {
        const last = out[out.length - 1];
        if (last && last.type === 'text') last.text += ch;
        else out.push({ type: 'text', text: ch });
    };
    while (i < input.length) {
        let matched = false;

        // Colour: `{c:name}…{/c}` with a valid palette name and a balanced close.
        const open = COLOR_OPEN_RE.exec(input.slice(i));
        if (open && VALID_COLORS.has(open[1])) {
            const innerStart = i + open[0].length;
            const close = findColorClose(input, innerStart);
            if (close !== -1) {
                out.push({
                    type: 'color',
                    color: open[1] as NoteColor,
                    children: parseInline(input.slice(innerStart, close))
                });
                i = close + COLOR_CLOSE.length;
                continue;
            }
        }

        for (const { delim, mark } of DELIMITERS) {
            if (!input.startsWith(delim, i)) continue;
            const close = input.indexOf(delim, i + delim.length);
            // Require non-empty content between the markers to count as a mark.
            if (close > i + delim.length) {
                out.push({ type: 'mark', mark, delim, children: parseInline(input.slice(i + delim.length, close)) });
                i = close + delim.length;
                matched = true;
                break;
            }
        }
        if (!matched) {
            pushText(input[i]);
            i++;
        }
    }
    return out;
}

function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Class names the editor renderer wraps marked text / dimmed markers with. */
export interface MarkClasses {
    marker: string;
    bold: string;
    italic: string;
    underline: string;
    strike: string;
    /** Base class for a coloured run; the actual tint is set inline via the token. */
    color: string;
}

function nodesToEditorHtml(nodes: InlineNode[], cls: MarkClasses): string {
    return nodes
        .map((n) => {
            if (n.type === 'text') return escapeHtml(n.text);
            if (n.type === 'color') {
                const open = `<span class="${cls.marker}">${escapeHtml(colorOpen(n.color))}</span>`;
                const close = `<span class="${cls.marker}">${escapeHtml(COLOR_CLOSE)}</span>`;
                const inner = `<span class="${cls.color}" style="color: var(--note-${n.color})">${nodesToEditorHtml(
                    n.children,
                    cls
                )}</span>`;
                return open + inner + close;
            }
            const marker = `<span class="${cls.marker}">${escapeHtml(n.delim)}</span>`;
            const inner = `<span class="${cls[n.mark]}">${nodesToEditorHtml(n.children, cls)}</span>`;
            return marker + inner + marker;
        })
        .join('');
}

/**
 * Render markdown to HTML that keeps the markers visible (dimmed) and styles the
 * marked text. Crucially, the rendered element's textContent equals `input`
 * character-for-character, so the editor can map the caret by plain offset.
 */
export function inlineToEditorHtml(input: string, cls: MarkClasses): string {
    return nodesToEditorHtml(parseInline(input), cls);
}

const TAGS: Record<InlineMark, string> = { bold: 'strong', italic: 'em', underline: 'u', strike: 's' };

function nodesToHtml(nodes: InlineNode[]): string {
    return nodes
        .map((n) => {
            if (n.type === 'text') return escapeHtml(n.text);
            if (n.type === 'color')
                return `<span style="color: var(--note-${n.color})">${nodesToHtml(n.children)}</span>`;
            return `<${TAGS[n.mark]}>${nodesToHtml(n.children)}</${TAGS[n.mark]}>`;
        })
        .join('');
}

/** Render markdown to clean semantic HTML (markers removed) — used by the PDF. */
export function inlineToHtml(input: string): string {
    return nodesToHtml(parseInline(input));
}

function nodesToPlain(nodes: InlineNode[]): string {
    return nodes.map((n) => (n.type === 'text' ? n.text : nodesToPlain(n.children))).join('');
}

/** Strip all inline markers, leaving plain text — used by previews. */
export function stripInline(input: string): string {
    return nodesToPlain(parseInline(input));
}
