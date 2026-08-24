import { inlineToHtml } from './markdown';
import { NOTE_COLOR_OPTIONS } from './noteColors';

import type { NoteBlock, NoteColor } from '@deveye/types';

/**
 * Export a note to PDF, client-side, with its inline markdown fully rendered.
 *
 * The note is laid out as a clean, typographic document (elegant serif, roomy
 * margins, harmonious spacing) into a hidden iframe, then sent to the browser's
 * print dialog — which offers "Save as PDF". No dependency, real selectable
 * text, and the decrypted content never leaves the page (zero-knowledge intact).
 */

function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Render an inline string to HTML, keeping in-block line breaks. */
function lineHtml(text: string): string {
    return inlineToHtml(text).replace(/\n/g, '<br/>');
}

/** Inline style tinting a list item's marker (`::marker` reads `--li-marker`). */
function markerStyle(color?: NoteColor): string {
    return color ? ` style="--li-marker: var(--note-${color})"` : '';
}

/**
 * `:root` block re-declaring the note colour tokens with their live computed
 * values, so `var(--note-<name>)` resolves inside the isolated print document
 * (which doesn't inherit the app's theme). Keeps theme.css the single source.
 */
function noteColorVarsCss(): string {
    const root = getComputedStyle(document.documentElement);
    const vars = NOTE_COLOR_OPTIONS.map((o) => {
        const value = root.getPropertyValue(`--note-${o.value}`).trim() || 'inherit';
        return `--note-${o.value}: ${value};`;
    }).join('');
    return `:root{${vars}}`;
}

/** Turn the typed blocks into the document body, grouping consecutive lists. */
function blocksToHtml(blocks: NoteBlock[]): string {
    let html = '';
    let i = 0;
    while (i < blocks.length) {
        const block = blocks[i];
        if (block.type === 'bullet') {
            let items = '';
            while (i < blocks.length) {
                const b = blocks[i];
                if (b.type !== 'bullet') break;
                items += `<li${markerStyle(b.color)}>${lineHtml(b.text)}</li>`;
                i++;
            }
            html += `<ul>${items}</ul>`;
            continue;
        }
        if (block.type === 'number') {
            let items = '';
            while (i < blocks.length) {
                const b = blocks[i];
                if (b.type !== 'number') break;
                items += `<li${markerStyle(b.color)}>${lineHtml(b.text)}</li>`;
                i++;
            }
            html += `<ol>${items}</ol>`;
            continue;
        }
        if (block.type === 'check') {
            let items = '';
            while (i < blocks.length) {
                const b = blocks[i];
                if (b.type !== 'check') break;
                const box = b.color ? ` style="color: var(--note-${b.color})"` : '';
                items += `<li class="check${b.done ? ' done' : ''}"><span class="box"${box}>${
                    b.done ? '☑' : '☐'
                }</span><span>${lineHtml(b.text)}</span></li>`;
                i++;
            }
            html += `<ul class="checks">${items}</ul>`;
            continue;
        }
        if (block.type === 'heading') {
            html += `<h${block.level}>${lineHtml(block.text)}</h${block.level}>`;
            i++;
            continue;
        }
        if (block.type === 'divider') {
            html += `<hr${block.color ? ` style="border-color: var(--note-${block.color})"` : ''}/>`;
            i++;
            continue;
        }
        html += `<p>${lineHtml(block.text)}</p>`;
        i++;
    }
    return html;
}

/* A clean, modern sans-serif stack — system UI fonts, no web download needed. */
const SANS =
    "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans', sans-serif";

/**
 * The print-only stylesheet: a modern sans-serif, generous margins and a sober
 * vertical rhythm. A discreet page number sits bottom-centre — the most neutral,
 * widely accepted convention (supported via CSS page margin boxes in Chrome 131+
 * / Safari 18.2+). The document carries no URL/site chrome, only its own title.
 */
const STYLE = `
    @page {
        margin: 2cm 2.2cm 1.8cm;
        @bottom-center {
            content: counter(page);
            font-family: ${SANS};
            font-size: 9pt;
            color: #a0a0a6;
        }
    }
    * { box-sizing: border-box; }
    body {
        margin: 0;
        font-family: ${SANS};
        color: #1d1d1f;
        font-size: 11pt;
        line-height: 1.6;
        -webkit-font-smoothing: antialiased;
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
    }
    .title { font-size: 22pt; font-weight: 700; letter-spacing: -0.02em; line-height: 1.2; margin: 0 0 6pt; }
    .meta { color: #9a9a9f; font-size: 9.5pt; margin: 0; padding-bottom: 16pt; border-bottom: 1px solid #ededf1; }
    .body { margin-top: 22pt; }
    h1, h2, h3, h4, h5 { font-weight: 600; letter-spacing: -0.01em; line-height: 1.3; margin: 18pt 0 6pt; }
    h1 { font-size: 17pt; }
    h2 { font-size: 14.5pt; }
    h3 { font-size: 12.5pt; }
    h4 { font-size: 11.5pt; }
    h5 { font-size: 10pt; text-transform: uppercase; letter-spacing: 0.06em; color: #6a6a70; }
    .body > :first-child { margin-top: 0; }
    p { margin: 0 0 9pt; }
    ul, ol { margin: 0 0 9pt; padding-left: 1.4em; }
    li { margin: 3pt 0; padding-left: 2px; }
    li::marker { color: var(--li-marker, currentColor); }
    ul.checks { list-style: none; padding-left: 0; }
    ul.checks li { display: flex; gap: 9px; align-items: baseline; }
    ul.checks .box { font-size: 12pt; line-height: 1; color: #6a6a70; }
    ul.checks li.done span:last-child { color: #a0a0a6; text-decoration: line-through; }
    hr { border: none; border-top: 1px solid #e4e4e8; margin: 18pt 0; }
    strong { font-weight: 700; }
    em { font-style: italic; }
    u { text-decoration: underline; }
    s { text-decoration: line-through; }
`;

export function exportNotePdf(title: string, blocks: NoteBlock[], meta?: string): void {
    const safeTitle = escapeHtml(title.trim() || 'Sans titre');
    const doc = `<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8"><title>${safeTitle}</title><style>${noteColorVarsCss()}${STYLE}</style></head>
<body>
    <div class="title">${safeTitle}</div>
    ${meta ? `<div class="meta">${escapeHtml(meta)}</div>` : ''}
    <div class="body">${blocksToHtml(blocks)}</div>
</body></html>`;

    const iframe = document.createElement('iframe');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;';
    document.body.appendChild(iframe);

    const win = iframe.contentWindow;
    if (!win) {
        iframe.remove();
        return;
    }
    win.document.open();
    win.document.write(doc);
    win.document.close();

    // Let the document lay out before invoking print, then drop the iframe.
    window.setTimeout(() => {
        win.focus();
        win.print();
        window.setTimeout(() => iframe.remove(), 1000);
    }, 250);
}
