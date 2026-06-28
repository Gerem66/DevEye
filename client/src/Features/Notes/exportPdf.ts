import { inlineToHtml } from './markdown';

import type { NoteBlock } from 'deveye-types';

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
                items += `<li>${lineHtml(b.text)}</li>`;
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
                items += `<li>${lineHtml(b.text)}</li>`;
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
                items += `<li class="check${b.done ? ' done' : ''}"><span class="box">${
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
            html += '<hr/>';
            i++;
            continue;
        }
        html += `<p>${lineHtml(block.text)}</p>`;
        i++;
    }
    return html;
}

/** The print-only stylesheet: refined serif, generous margins, sober rhythm. */
const STYLE = `
    @page { margin: 2.2cm 2.4cm; }
    * { box-sizing: border-box; }
    body {
        margin: 0;
        font-family: 'Iowan Old Style', 'Palatino Linotype', Palatino, 'Book Antiqua', Georgia, serif;
        color: #1d1d1f;
        font-size: 12pt;
        line-height: 1.62;
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
    }
    .title { font-size: 23pt; font-weight: 700; letter-spacing: -0.01em; margin: 0 0 4pt; }
    .meta { color: #8a8a8e; font-size: 9.5pt; margin: 0; padding-bottom: 14pt; border-bottom: 1px solid #e6e6e9; }
    .body { margin-top: 16pt; }
    h1, h2, h3, h4, h5 { font-weight: 700; line-height: 1.25; margin: 16pt 0 6pt; }
    h1 { font-size: 18pt; }
    h2 { font-size: 15.5pt; }
    h3 { font-size: 13.5pt; }
    h4 { font-size: 12pt; }
    h5 { font-size: 11pt; text-transform: uppercase; letter-spacing: 0.05em; color: #555; }
    p { margin: 0 0 8pt; }
    ul, ol { margin: 0 0 8pt; padding-left: 1.5em; }
    li { margin: 2.5pt 0; }
    ul.checks { list-style: none; padding-left: 0; }
    ul.checks li { display: flex; gap: 8px; align-items: baseline; }
    ul.checks .box { font-size: 12.5pt; line-height: 1; }
    ul.checks li.done span:last-child { color: #8a8a8e; text-decoration: line-through; }
    hr { border: none; border-top: 1px solid #d9d9de; margin: 16pt 0; }
    strong { font-weight: 700; }
    em { font-style: italic; }
    u { text-decoration: underline; }
    s { text-decoration: line-through; }
`;

export function exportNotePdf(title: string, blocks: NoteBlock[], meta?: string): void {
    const safeTitle = escapeHtml(title.trim() || 'Sans titre');
    const doc = `<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8"><title>${safeTitle}</title><style>${STYLE}</style></head>
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
