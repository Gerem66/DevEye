import type { MimeNode } from './tree';

/**
 * Les octets qu'un `BODY[section]` désigne (RFC 3501 §6.4.5) : une partie par
 * son chemin (`1.2`), puis éventuellement `HEADER`, `TEXT`, `MIME`, ou une
 * sélection d'en-têtes.
 */

export interface SectionSpec {
    /** Le chemin numérique : `[1, 2]` pour `1.2`, vide pour le message entier. */
    path: number[];
    /** Ce qu'on prend de la partie ; `''` : tout son corps (ou le message entier sans chemin). */
    part: '' | 'HEADER' | 'TEXT' | 'MIME' | 'HEADER.FIELDS' | 'HEADER.FIELDS.NOT';
    fields: string[];
}

export function parseSection(text: string): SectionSpec | null {
    const m = /^((?:\d+\.)*\d+)?\.?([A-Za-z.]+)?(?:\s*\(([^)]*)\))?$/.exec(text.trim());
    if (!m) return null;
    const part = (m[2] ?? '').toUpperCase();
    if (!['', 'HEADER', 'TEXT', 'MIME', 'HEADER.FIELDS', 'HEADER.FIELDS.NOT'].includes(part)) return null;
    const path = m[1] ? m[1].split('.').map(Number) : [];
    if (path.some((n) => n < 1)) return null;
    // `MIME` n'a de sens que pour une partie, jamais pour le message lui-même.
    if (part === 'MIME' && path.length === 0) return null;
    const fields = (m[3] ?? '')
        .split(/\s+/)
        .map((name) => name.replace(/^"|"$/g, '').toLowerCase())
        .filter((name) => name.length > 0);
    if (part.startsWith('HEADER.FIELDS') && fields.length === 0) return null;
    return { path, part: part as SectionSpec['part'], fields };
}

/** La partie au bout du chemin, ou `null`. Un message sans multipart a une seule partie, la `1`. */
function descend(root: MimeNode, path: readonly number[]): MimeNode | null {
    let node = root;
    for (const index of path) {
        // Sous un message enfermé, les numéros désignent SES parties.
        const container = node.message ?? node;
        if (container.type === 'multipart' && container.children.length > 0) {
            const child = container.children[index - 1];
            if (!child) return null;
            node = child;
        } else {
            if (index !== 1) return null;
            node = container;
        }
    }
    return node;
}

function selectHeaders(block: Buffer, fields: readonly string[], keep: boolean): Buffer {
    const lines = block.toString('latin1').split(/(?<=\n)/);
    const out: string[] = [];
    let taking = false;
    for (const line of lines) {
        if (line === '\r\n' || line === '\n') break;
        if (line[0] !== ' ' && line[0] !== '\t') {
            const colon = line.indexOf(':');
            const name = colon > 0 ? line.slice(0, colon).trim().toLowerCase() : '';
            taking = fields.includes(name) === keep;
        }
        if (taking) out.push(line);
    }
    // La ligne vide qui clôt les en-têtes fait partie de la réponse, même sans aucun en-tête retenu.
    return Buffer.from(`${out.join('')}\r\n`, 'latin1');
}

export function extractSection(raw: Buffer, root: MimeNode, spec: SectionSpec): Buffer | null {
    const node = descend(root, spec.path);
    if (!node) return null;
    // `HEADER` et `TEXT` d'une partie parlent du message qu'elle enferme.
    const message = spec.path.length === 0 ? root : node.message;

    switch (spec.part) {
        case '':
            return spec.path.length === 0 ? raw : raw.subarray(node.bodyStart, node.end);
        case 'MIME':
            return raw.subarray(node.start, node.bodyStart);
        case 'HEADER':
            return message ? raw.subarray(message.start, message.bodyStart) : null;
        case 'TEXT':
            return message ? raw.subarray(message.bodyStart, message.end) : null;
        case 'HEADER.FIELDS':
        case 'HEADER.FIELDS.NOT':
            return message
                ? selectHeaders(
                      raw.subarray(message.start, message.bodyStart),
                      spec.fields,
                      spec.part === 'HEADER.FIELDS'
                  )
                : null;
    }
}

/** `<début.longueur>` : la tranche demandée, vide au-delà de la fin. */
export function slicePartial(data: Buffer, partial: { start: number; length: number } | null): Buffer {
    if (partial === null) return data;
    return data.subarray(Math.min(partial.start, data.length), Math.min(partial.start + partial.length, data.length));
}
