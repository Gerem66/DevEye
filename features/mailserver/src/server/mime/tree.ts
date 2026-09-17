/**
 * L'arbre MIME d'un message, avec les positions de chaque partie dans le
 * message brut. C'est ce que demande IMAP et qu'aucun analyseur de courrier ne
 * donne : `BODYSTRUCTURE` veut des tailles et des comptes de lignes,
 * `BODY[1.2]` veut des octets exacts. Calculé une fois, à la remise.
 *
 * Toute chaîne tirée du message est une chaîne d'OCTETS (latin1) : un en-tête
 * en UTF-8 brut ressort sur le fil tel qu'il est entré.
 */

export interface ContentField {
    value: string;
    params: Record<string, string>;
}

export interface MimeNode {
    /** Début des en-têtes, début du corps, fin du corps (exclue), dans le message brut. */
    start: number;
    bodyStart: number;
    end: number;
    type: string;
    subtype: string;
    params: Record<string, string>;
    disposition: ContentField | null;
    encoding: string;
    id: string | null;
    description: string | null;
    md5: string | null;
    language: string[] | null;
    location: string | null;
    /** Lignes du corps, que `BODYSTRUCTURE` donne pour `text/*` et `message/rfc822`. */
    lines: number;
    /** Les parties d'un `multipart/*`. */
    children: MimeNode[];
    /** Le message enfermé dans un `message/rfc822`. */
    message: MimeNode | null;
    /** Les en-têtes dont l'enveloppe se tire ; gardés pour la racine et les messages enfermés. */
    headers: MimeHeader[] | null;
}

export interface MimeHeader {
    /** En minuscules. */
    key: string;
    /** Dépliée, sans le nom. */
    value: string;
}

const LF = 0x0a;
const CR = 0x0d;

/** Au-delà, un message fabriqué pour épuiser la pile s'arrête d'être exploré. */
const MAX_DEPTH = 20;
const MAX_PARTS = 1_000;

/** La fin des en-têtes : la première ligne vide. Rend le début du corps, ou `end` s'il n'y en a pas. */
function findBodyStart(buf: Buffer, start: number, end: number): number {
    // Un message qui s'ouvre sur une ligne vide n'a pas d'en-têtes.
    if (buf[start] === LF) return start + 1;
    if (buf[start] === CR && buf[start + 1] === LF) return start + 2;
    for (let i = start; i < end; i += 1) {
        if (buf[i] !== LF) continue;
        if (buf[i + 1] === LF) return Math.min(i + 2, end);
        if (buf[i + 1] === CR && buf[i + 2] === LF) return Math.min(i + 3, end);
    }
    return end;
}

export function parseHeaders(block: string): MimeHeader[] {
    const headers: MimeHeader[] = [];
    for (const line of block.split(/\r?\n/)) {
        if (line === '') break;
        const last = headers[headers.length - 1];
        if ((line[0] === ' ' || line[0] === '\t') && last) {
            last.value += ` ${line.trim()}`;
            continue;
        }
        const colon = line.indexOf(':');
        if (colon <= 0) continue;
        headers.push({ key: line.slice(0, colon).trim().toLowerCase(), value: line.slice(colon + 1).trim() });
    }
    return headers;
}

export const headerOf = (headers: readonly MimeHeader[], key: string): string | null =>
    headers.find((h) => h.key === key)?.value ?? null;

/** `valeur; clé=val; clé="val avec ; et \" dedans"`. Les continuations RFC 2231 restent telles quelles. */
export function parseContentField(raw: string): ContentField {
    const params: Record<string, string> = {};
    let i = raw.indexOf(';');
    const value = (i === -1 ? raw : raw.slice(0, i)).trim().toLowerCase();
    while (i !== -1 && i < raw.length) {
        i += 1;
        const eq = raw.indexOf('=', i);
        if (eq === -1) break;
        const key = raw.slice(i, eq).trim().toLowerCase();
        let j = eq + 1;
        while (raw[j] === ' ') j += 1;
        let val = '';
        if (raw[j] === '"') {
            j += 1;
            while (j < raw.length && raw[j] !== '"') {
                if (raw[j] === '\\' && j + 1 < raw.length) j += 1;
                val += raw[j];
                j += 1;
            }
            i = raw.indexOf(';', j);
        } else {
            const stop = raw.indexOf(';', j);
            val = raw.slice(j, stop === -1 ? raw.length : stop).trim();
            i = stop;
        }
        if (key.length > 0 && !(key in params)) params[key] = val;
    }
    return { value, params };
}

function countLines(buf: Buffer, start: number, end: number): number {
    if (end <= start) return 0;
    let lines = 0;
    for (let i = start; i < end; i += 1) if (buf[i] === LF) lines += 1;
    return buf[end - 1] === LF ? lines : lines + 1;
}

interface Budget {
    parts: number;
}

/** Les bornes des parties d'un multipart : entre deux lignes `--frontière`. */
function splitParts(buf: Buffer, start: number, end: number, boundary: string): [number, number][] {
    const delimiter = Buffer.from(`--${boundary}`, 'latin1');
    const parts: [number, number][] = [];
    let open = -1;
    let at = start;
    while (at < end) {
        const hit = buf.indexOf(delimiter, at);
        if (hit === -1 || hit >= end) break;
        at = hit + delimiter.length;
        if (hit !== start && buf[hit - 1] !== LF) continue;

        const closing = buf[at] === 0x2d && buf[at + 1] === 0x2d;
        let lineEnd = buf.indexOf(LF, at);
        if (lineEnd === -1 || lineEnd >= end) lineEnd = end - 1;
        // Après la frontière, rien que des blancs : sinon c'est un préfixe d'une autre frontière.
        const tail = buf.subarray(closing ? at + 2 : at, lineEnd + 1).toString('latin1');
        if (tail.trim() !== '') continue;

        if (open !== -1) {
            // La fin de ligne qui précède la frontière lui appartient, pas à la partie.
            let partEnd = hit;
            if (partEnd > open && buf[partEnd - 1] === LF) partEnd -= 1;
            if (partEnd > open && buf[partEnd - 1] === CR) partEnd -= 1;
            parts.push([open, Math.max(open, partEnd)]);
        }
        if (closing) return parts;
        open = lineEnd + 1;
        at = open;
    }
    // Frontière de fin absente (message tronqué) : la dernière partie va jusqu'au bout.
    if (open !== -1 && open <= end) parts.push([open, end]);
    return parts;
}

function parseNode(
    buf: Buffer,
    start: number,
    end: number,
    fallbackType: string,
    depth: number,
    budget: Budget,
    keepHeaders: boolean
): MimeNode {
    const bodyStart = findBodyStart(buf, start, end);
    const headers = parseHeaders(buf.subarray(start, bodyStart).toString('latin1'));
    const contentType = parseContentField(headerOf(headers, 'content-type') ?? fallbackType);
    const slash = contentType.value.indexOf('/');
    const type = slash > 0 ? contentType.value.slice(0, slash) : 'text';
    const subtype = slash > 0 ? contentType.value.slice(slash + 1) : 'plain';
    const dispositionRaw = headerOf(headers, 'content-disposition');
    const language = headerOf(headers, 'content-language');
    const encoding = (headerOf(headers, 'content-transfer-encoding') ?? '7bit').toLowerCase();

    const node: MimeNode = {
        start,
        bodyStart,
        end,
        type,
        subtype,
        params: slash > 0 ? contentType.params : {},
        disposition: dispositionRaw === null ? null : parseContentField(dispositionRaw),
        encoding,
        id: headerOf(headers, 'content-id'),
        description: headerOf(headers, 'content-description'),
        md5: headerOf(headers, 'content-md5'),
        language: language === null ? null : language.split(',').map((tag) => tag.trim()),
        location: headerOf(headers, 'content-location'),
        lines: countLines(buf, bodyStart, end),
        children: [],
        message: null,
        headers: keepHeaders ? headers : null
    };

    budget.parts += 1;
    if (depth >= MAX_DEPTH || budget.parts >= MAX_PARTS) return node;

    const boundary = node.params.boundary;
    if (type === 'multipart' && boundary) {
        const childType = subtype === 'digest' ? 'message/rfc822' : 'text/plain';
        for (const [partStart, partEnd] of splitParts(buf, bodyStart, end, boundary)) {
            node.children.push(parseNode(buf, partStart, partEnd, childType, depth + 1, budget, false));
        }
        // Un multipart sans partie lisible se présente comme du texte : `BODYSTRUCTURE` n'a pas de forme pour le vide.
        if (node.children.length === 0) {
            node.type = 'text';
            node.subtype = 'plain';
        }
    } else if (type === 'message' && subtype === 'rfc822' && !['base64', 'quoted-printable'].includes(encoding)) {
        node.message = parseNode(buf, bodyStart, end, 'text/plain', depth + 1, budget, true);
    }
    return node;
}

export function parseMime(raw: Buffer): MimeNode {
    return parseNode(raw, 0, raw.length, 'text/plain', 0, { parts: 0 }, true);
}
