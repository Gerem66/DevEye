/**
 * La lecture d'une commande IMAP : d'abord la ligne et ses littéraux
 * (`CommandReader`), puis ses jetons (`parseCommand`).
 *
 * Un littéral `{n}` coupe la ligne : le client attend un `+` avant d'envoyer
 * ses n octets, sauf s'il a écrit `{n+}` (LITERAL+), puis la ligne reprend.
 * Une commande arrive donc comme une suite de segments, texte ou octets.
 */

export type Segment = string | Buffer;

export type Token =
    { t: 'atom'; v: string } | { t: 'str'; v: string } | { t: 'lit'; v: Buffer } | { t: 'list'; v: Token[] };

export interface ReaderLimits {
    /** Longueur d'une ligne, hors littéraux. */
    maxLine: number;
    maxLiteral: number;
}

export interface ReaderHandlers {
    /** Une commande complète, ou la ligne de réponse à une continuation. */
    onLine(segments: Segment[]): void;
    /** Un littéral synchronisant attend son `+`. */
    onContinue(): void;
    /** La ligne ou le littéral dépasse les bornes : la connexion ne peut plus être resynchronisée. */
    onOverflow(reason: 'line' | 'literal'): void;
}

const LITERAL_MARK = /\{(\d+)(\+?)\}$/;

export class CommandReader {
    private pending: Buffer = Buffer.alloc(0);
    private segments: Segment[] = [];
    private literalLeft = 0;
    private literalParts: Buffer[] = [];
    private dead = false;

    constructor(
        private limits: ReaderLimits,
        private readonly handlers: ReaderHandlers
    ) {}

    /** Les bornes changent avec l'état de la session : un inconnu n'a pas droit aux littéraux d'un APPEND. */
    setLimits(limits: ReaderLimits): void {
        this.limits = limits;
    }

    feed(chunk: Buffer): void {
        if (this.dead) return;
        this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
        while (!this.dead && this.step()) {
            // Tant qu'il reste une ligne ou un littéral complet à consommer.
        }
    }

    private step(): boolean {
        if (this.literalLeft > 0) {
            if (this.pending.length === 0) return false;
            const take = this.pending.subarray(0, this.literalLeft);
            this.literalParts.push(take);
            this.literalLeft -= take.length;
            this.pending = this.pending.subarray(take.length);
            if (this.literalLeft > 0) return false;
            this.segments.push(Buffer.concat(this.literalParts));
            this.literalParts = [];
            return true;
        }

        const lf = this.pending.indexOf(0x0a);
        if (lf === -1) {
            if (this.pending.length > this.limits.maxLine) this.fail('line');
            return false;
        }
        if (lf > this.limits.maxLine) {
            this.fail('line');
            return false;
        }
        const end = lf > 0 && this.pending[lf - 1] === 0x0d ? lf - 1 : lf;
        const line = this.pending.subarray(0, end).toString('latin1');
        this.pending = this.pending.subarray(lf + 1);

        const mark = LITERAL_MARK.exec(line);
        if (!mark) {
            this.segments.push(line);
            const done = this.segments;
            this.segments = [];
            this.handlers.onLine(done);
            return true;
        }

        const size = Number(mark[1]);
        if (size > this.limits.maxLiteral) {
            this.fail('literal');
            return false;
        }
        this.segments.push(line.slice(0, mark.index));
        if (size === 0) {
            this.segments.push(Buffer.alloc(0));
        } else {
            this.literalLeft = size;
        }
        if (mark[2] !== '+') this.handlers.onContinue();
        return true;
    }

    private fail(reason: 'line' | 'literal'): void {
        this.dead = true;
        this.pending = Buffer.alloc(0);
        this.handlers.onOverflow(reason);
    }
}

export class ParseError extends Error {}

class Cursor {
    private seg = 0;
    private pos = 0;

    constructor(private readonly segments: readonly Segment[]) {}

    private text(): string | null {
        const current = this.segments[this.seg];
        return typeof current === 'string' ? current : null;
    }

    /** Passe les segments de texte épuisés. */
    private settle(): void {
        for (;;) {
            const text = this.text();
            if (text === null || this.pos < text.length) return;
            if (this.seg >= this.segments.length - 1) return;
            this.seg += 1;
            this.pos = 0;
        }
    }

    done(): boolean {
        this.settle();
        const text = this.text();
        return this.seg >= this.segments.length - 1 && (text === null ? false : this.pos >= text.length);
    }

    peek(): string | null {
        this.settle();
        const text = this.text();
        return text === null || this.pos >= text.length ? null : text[this.pos];
    }

    next(): string | null {
        const c = this.peek();
        if (c !== null) this.pos += 1;
        return c;
    }

    literal(): Buffer | null {
        this.settle();
        const current = this.segments[this.seg];
        if (typeof current === 'string' || current === undefined) return null;
        this.seg += 1;
        this.pos = 0;
        return current;
    }

    skipSpaces(): void {
        while (this.peek() === ' ') this.pos += 1;
    }
}

function readQuoted(cursor: Cursor): Token {
    let out = '';
    for (;;) {
        const c = cursor.next();
        if (c === null) throw new ParseError('Guillemet non fermé');
        if (c === '"') return { t: 'str', v: out };
        if (c === '\\') {
            const escaped = cursor.next();
            if (escaped === null) throw new ParseError('Guillemet non fermé');
            out += escaped;
        } else {
            out += c;
        }
    }
}

/**
 * Un atome, crochets compris : `BODY.PEEK[HEADER.FIELDS (DATE FROM)]<0.100>`
 * est un seul jeton, espaces et parenthèses de la section inclus.
 */
function readAtom(cursor: Cursor): Token {
    let out = '';
    let brackets = 0;
    for (;;) {
        const c = cursor.peek();
        if (c === null) break;
        if (brackets === 0 && (c === ' ' || c === '(' || c === ')')) break;
        if (c === '[') brackets += 1;
        if (c === ']') brackets = Math.max(0, brackets - 1);
        out += c;
        cursor.next();
    }
    if (out === '') throw new ParseError('Jeton attendu');
    return { t: 'atom', v: out };
}

function readToken(cursor: Cursor, depth: number): Token {
    cursor.skipSpaces();
    const literal = cursor.literal();
    if (literal !== null) return { t: 'lit', v: literal };
    const c = cursor.peek();
    if (c === null) throw new ParseError('Jeton attendu');
    if (c === '"') {
        cursor.next();
        return readQuoted(cursor);
    }
    if (c === '(') {
        if (depth > 16) throw new ParseError('Listes trop imbriquées');
        cursor.next();
        const items: Token[] = [];
        for (;;) {
            cursor.skipSpaces();
            if (cursor.peek() === ')') {
                cursor.next();
                return { t: 'list', v: items };
            }
            if (cursor.done()) throw new ParseError('Liste non fermée');
            items.push(readToken(cursor, depth + 1));
        }
    }
    if (c === ')') throw new ParseError('Parenthèse inattendue');
    return readAtom(cursor);
}

export interface Command {
    tag: string;
    name: string;
    args: Token[];
}

export function parseCommand(segments: readonly Segment[]): Command {
    const cursor = new Cursor(segments);
    const tag = readToken(cursor, 0);
    if (tag.t !== 'atom' || /[+*%"\\{(]/.test(tag.v)) throw new ParseError('Étiquette invalide');
    const name = readToken(cursor, 0);
    if (name.t !== 'atom') throw new ParseError('Commande attendue');
    const args: Token[] = [];
    for (;;) {
        cursor.skipSpaces();
        if (cursor.done()) break;
        args.push(readToken(cursor, 0));
    }
    return { tag: tag.v, name: name.v.toUpperCase(), args };
}

/** Un argument « chaîne » : atome, guillemets ou littéral, rendu en chaîne d'octets. */
export function stringOf(token: Token | undefined): string | null {
    if (!token) return null;
    if (token.t === 'atom' || token.t === 'str') return token.v;
    if (token.t === 'lit') return token.v.toString('latin1');
    return null;
}

/** Une chaîne d'octets relue comme de l'UTF-8 : un mot de passe, un terme de recherche. */
export const utf8Of = (bytes: string): string => Buffer.from(bytes, 'latin1').toString('utf8');
