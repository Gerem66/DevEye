/**
 * Tiny inline-markdown engine shared by the note editor (live rendering), the
 * card preview (markers stripped) and the PDF export (semantic HTML).
 *
 * Supported inline marks, kept as markers inside a block's plain text:
 *  - `**bold**`        → bold
 *  - `*italic*`        → italic
 *  - `__underline__`   → underline
 *  - `~~strike~~`      → strikethrough
 *
 * Marks nest (e.g. `**bold _und_**`); overlapping ranges aren't supported (no
 * standard markdown is). Two-char delimiters are matched before the single `*`,
 * and `_` only forms underline as a pair so it never clashes with snake_case.
 */

export type InlineMark = 'bold' | 'italic' | 'underline' | 'strike';

type InlineNode =
    { type: 'text'; text: string } | { type: 'mark'; mark: InlineMark; delim: string; children: InlineNode[] };

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
}

function nodesToEditorHtml(nodes: InlineNode[], cls: MarkClasses): string {
    return nodes
        .map((n) => {
            if (n.type === 'text') return escapeHtml(n.text);
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
        .map((n) =>
            n.type === 'text' ? escapeHtml(n.text) : `<${TAGS[n.mark]}>${nodesToHtml(n.children)}</${TAGS[n.mark]}>`
        )
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
