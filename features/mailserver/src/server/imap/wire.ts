/**
 * La mise en forme des réponses IMAP : le seul endroit où des octets s'écrivent.
 *
 * Une chaîne est une chaîne d'OCTETS (latin1), comme tout ce que `mime/` tire
 * d'un message : elle ressort telle qu'elle est entrée. Ce qui vient du serveur
 * lui-même (noms de dossiers en UTF-7 modifié, drapeaux) est de l'ASCII, pour
 * qui les deux lectures coïncident.
 */

export type ImapValue =
    | null
    | number
    | string
    | ImapValue[]
    | { atom: string }
    | { literal: Buffer }
    /** Des valeurs collées sans espace : les parties d'un multipart dans `BODYSTRUCTURE`. */
    | { glued: ImapValue[] };

export const atom = (text: string): { atom: string } => ({ atom: text });

/** Guillemets possibles : court, ASCII imprimable, ni guillemet ni antislash à échapper en masse. */
function quotable(text: string): boolean {
    if (text.length > 512) return false;
    for (let i = 0; i < text.length; i += 1) {
        const code = text.charCodeAt(i);
        if (code < 0x20 || code > 0x7e) return false;
    }
    return true;
}

function writeValue(value: ImapValue, out: Buffer[]): void {
    if (value === null) {
        out.push(Buffer.from('NIL'));
    } else if (typeof value === 'number') {
        out.push(Buffer.from(String(value)));
    } else if (typeof value === 'string') {
        if (quotable(value)) {
            out.push(Buffer.from(`"${value.replace(/([\\"])/g, '\\$1')}"`, 'latin1'));
        } else {
            const bytes = Buffer.from(value, 'latin1');
            out.push(Buffer.from(`{${bytes.length}}\r\n`), bytes);
        }
    } else if (Array.isArray(value)) {
        out.push(Buffer.from('('));
        value.forEach((item, index) => {
            if (index > 0) out.push(Buffer.from(' '));
            writeValue(item, out);
        });
        out.push(Buffer.from(')'));
    } else if ('atom' in value) {
        out.push(Buffer.from(value.atom, 'latin1'));
    } else if ('glued' in value) {
        for (const item of value.glued) writeValue(item, out);
    } else {
        out.push(Buffer.from(`{${value.literal.length}}\r\n`), value.literal);
    }
}

/** Une ligne de réponse : ses valeurs séparées par une espace, puis CRLF. */
export function formatLine(values: readonly ImapValue[]): Buffer {
    const out: Buffer[] = [];
    values.forEach((value, index) => {
        if (index > 0) out.push(Buffer.from(' '));
        writeValue(value, out);
    });
    out.push(Buffer.from('\r\n'));
    return Buffer.concat(out);
}

/** `* 12 FETCH (...)`, `* OK ...` : une réponse non étiquetée. */
export const untagged = (...values: ImapValue[]): Buffer => formatLine([atom('*'), ...values]);

/** `a1 OK [CODE] texte` : la réponse qui clôt une commande. */
export function tagged(tag: string, status: 'OK' | 'NO' | 'BAD', text: string, code?: string): Buffer {
    return Buffer.from(`${tag} ${status} ${code ? `[${code}] ` : ''}${text}\r\n`, 'latin1');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `17-Jul-1996 02:44:25 +0000` : la date interne d'un message, toujours rendue en UTC. */
export function formatInternalDate(ts: number): string {
    const d = new Date(ts * 1000);
    const two = (n: number): string => String(n).padStart(2, '0');
    return (
        `${two(d.getUTCDate())}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()} ` +
        `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())} +0000`
    );
}

/** L'inverse, pour APPEND et les clés de date de SEARCH (`17-Jul-1996`, avec ou sans heure). */
export function parseImapDate(text: string): number | null {
    const m = /^\s*(\d{1,2})-([A-Za-z]{3})-(\d{4})(?:\s+(\d{2}):(\d{2}):(\d{2})\s+([+-])(\d{2})(\d{2}))?\s*$/.exec(
        text
    );
    if (!m) return null;
    const month = MONTHS.findIndex((name) => name.toLowerCase() === m[2].toLowerCase());
    if (month === -1) return null;
    const utc = Date.UTC(Number(m[3]), month, Number(m[1]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0));
    const offset = m[7] ? (m[7] === '-' ? -1 : 1) * (Number(m[8]) * 60 + Number(m[9])) * 60_000 : 0;
    return Math.floor((utc - offset) / 1000);
}
