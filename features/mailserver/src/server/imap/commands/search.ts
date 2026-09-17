import { FLAG, type MessageMeta } from '../../engine/mailstore';
import { decodeHeaderText } from '../../mime/words';
import { headerOf, parseHeaders } from '../../mime/tree';
import type { Located } from '../mailboxView';
import { stringOf, utf8Of, type Command, type Token } from '../parser';
import { inSequenceSet, parseSequenceSet, type SequenceRange } from '../sequence';
import type { ImapSession } from '../session';
import { atom, parseImapDate } from '../wire';

/**
 * SEARCH : les critères deviennent un prédicat, évalué message par message. Les
 * critères sur les en-têtes lisent `meta` ; `BODY` et `TEXT` relisent le corps,
 * et c'est pourquoi leur portée est bornée.
 */

interface Probe {
    located: Located;
    maxSeq: number;
    maxUid: number;
    meta(): Promise<MessageMeta>;
    raw(): Promise<Buffer>;
}

type Predicate = (probe: Probe) => Promise<boolean> | boolean;

/** Relire le corps de chaque message d'un grand dossier épuiserait le serveur pour une seule commande. */
const MAX_BODY_SCANS = 2_000;
const DAY = 86_400;

class SearchSyntaxError extends Error {}

const fold = (text: string): string => text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();

function flagKey(bit: number, wanted: boolean): Predicate {
    return ({ located }) => ((located.message.flags & bit) !== 0) === wanted;
}

function headerKey(name: string, needle: string): Predicate {
    const wanted = fold(needle);
    return async (probe) => {
        const headers = parseHeaders((await probe.meta()).head);
        const values = headers.filter((h) => h.key === name).map((h) => fold(decodeHeaderText(h.value)));
        // Une aiguille vide cherche la seule présence de l'en-tête.
        return wanted === '' ? values.length > 0 : values.some((value) => value.includes(wanted));
    };
}

function dateKey(
    read: (probe: Probe) => Promise<number | null> | number | null,
    op: 'before' | 'on' | 'since',
    day: number
): Predicate {
    return async (probe) => {
        const ts = await read(probe);
        if (ts === null) return false;
        if (op === 'before') return ts < day;
        if (op === 'since') return ts >= day;
        return ts >= day && ts < day + DAY;
    };
}

const sentDate = async (probe: Probe): Promise<number | null> => {
    const raw = headerOf(parseHeaders((await probe.meta()).head), 'date');
    const ts = raw === null ? NaN : Date.parse(raw);
    return Number.isNaN(ts) ? null : Math.floor(ts / 1000);
};

class KeyReader {
    private at = 0;
    bodyScans = false;

    constructor(private readonly tokens: readonly Token[]) {}

    done(): boolean {
        return this.at >= this.tokens.length;
    }

    private take(): Token {
        const token = this.tokens[this.at];
        if (!token) throw new SearchSyntaxError('Critère incomplet');
        this.at += 1;
        return token;
    }

    private text(): string {
        const value = stringOf(this.take());
        if (value === null) throw new SearchSyntaxError('Chaîne attendue');
        return utf8Of(value);
    }

    private number(): number {
        const value = Number(this.text());
        if (!Number.isInteger(value) || value < 0) throw new SearchSyntaxError('Nombre attendu');
        return value;
    }

    private day(): number {
        const ts = parseImapDate(this.text());
        if (ts === null) throw new SearchSyntaxError('Date attendue');
        return ts;
    }

    private set(): SequenceRange[] {
        const ranges = parseSequenceSet(this.text());
        if (!ranges) throw new SearchSyntaxError('Ensemble de messages attendu');
        return ranges;
    }

    /** Un critère, qui peut en consommer d'autres (`NOT`, `OR`) ou être une liste, c'est-à-dire un ET. */
    key(): Predicate {
        const token = this.take();
        if (token.t === 'list') return allOf(new KeyReader(token.v).all(this));
        const name = stringOf(token)?.toUpperCase() ?? '';
        switch (name) {
            case 'ALL':
                return () => true;
            case 'ANSWERED':
                return flagKey(FLAG.Answered, true);
            case 'UNANSWERED':
                return flagKey(FLAG.Answered, false);
            case 'DELETED':
                return flagKey(FLAG.Deleted, true);
            case 'UNDELETED':
                return flagKey(FLAG.Deleted, false);
            case 'DRAFT':
                return flagKey(FLAG.Draft, true);
            case 'UNDRAFT':
                return flagKey(FLAG.Draft, false);
            case 'FLAGGED':
                return flagKey(FLAG.Flagged, true);
            case 'UNFLAGGED':
                return flagKey(FLAG.Flagged, false);
            case 'SEEN':
                return flagKey(FLAG.Seen, true);
            case 'UNSEEN':
                return flagKey(FLAG.Seen, false);
            // `\Recent` n'est jamais posé : tout message est « ancien ».
            case 'NEW':
            case 'RECENT':
                return () => false;
            case 'OLD':
                return () => true;
            case 'KEYWORD': {
                const keyword = this.text().toLowerCase();
                return ({ located }) => located.message.keywords.toLowerCase().split(' ').includes(keyword);
            }
            case 'UNKEYWORD': {
                const keyword = this.text().toLowerCase();
                return ({ located }) => !located.message.keywords.toLowerCase().split(' ').includes(keyword);
            }
            case 'LARGER': {
                const size = this.number();
                return ({ located }) => located.message.size > size;
            }
            case 'SMALLER': {
                const size = this.number();
                return ({ located }) => located.message.size < size;
            }
            case 'BEFORE':
                return dateKey(({ located }) => located.message.internal_date, 'before', this.day());
            case 'ON':
                return dateKey(({ located }) => located.message.internal_date, 'on', this.day());
            case 'SINCE':
                return dateKey(({ located }) => located.message.internal_date, 'since', this.day());
            case 'SENTBEFORE':
                return dateKey(sentDate, 'before', this.day());
            case 'SENTON':
                return dateKey(sentDate, 'on', this.day());
            case 'SENTSINCE':
                return dateKey(sentDate, 'since', this.day());
            case 'FROM':
            case 'TO':
            case 'CC':
            case 'BCC':
            case 'SUBJECT':
                return headerKey(name.toLowerCase(), this.text());
            case 'HEADER': {
                const field = this.text().toLowerCase();
                return headerKey(field, this.text());
            }
            case 'BODY':
            case 'TEXT': {
                const wanted = fold(this.text());
                this.bodyScans = true;
                return async (probe) => {
                    const meta = await probe.meta();
                    const raw = await probe.raw();
                    // Le texte brut, sans décoder les parties : suffisant pour du texte en clair, qui est le cas utile.
                    const from = name === 'BODY' ? meta.tree.bodyStart : 0;
                    return fold(raw.subarray(from).toString('utf8')).includes(wanted);
                };
            }
            case 'UID': {
                const set = this.set();
                return ({ located, maxUid }) => inSequenceSet(set, located.message.uid, maxUid);
            }
            case 'NOT': {
                const inner = this.key();
                return async (probe) => !(await inner(probe));
            }
            case 'OR': {
                const left = this.key();
                const right = this.key();
                return async (probe) => (await left(probe)) || (await right(probe));
            }
            default: {
                const set = parseSequenceSet(name);
                if (!set) throw new SearchSyntaxError(`Critère inconnu : ${name}`);
                return ({ located, maxSeq }) => inSequenceSet(set, located.seq, maxSeq);
            }
        }
    }

    all(parent?: KeyReader): Predicate[] {
        const keys: Predicate[] = [];
        while (!this.done()) keys.push(this.key());
        if (parent && this.bodyScans) parent.bodyScans = true;
        return keys;
    }
}

function allOf(keys: readonly Predicate[]): Predicate {
    return async (probe) => {
        for (const key of keys) if (!(await key(probe))) return false;
        return true;
    };
}

export async function searchCommand(
    session: ImapSession,
    cmd: Command,
    args: readonly Token[],
    byUid: boolean
): Promise<void> {
    const { view, mailbox } = session;
    if (!view || !mailbox) return session.bad(cmd, 'Select a mailbox first');

    let tokens = [...args];
    if (stringOf(tokens[0])?.toUpperCase() === 'CHARSET') {
        const charset = stringOf(tokens[1])?.toUpperCase();
        if (charset !== 'UTF-8' && charset !== 'US-ASCII')
            return session.no(cmd, 'Unsupported charset', 'BADCHARSET (UTF-8)');
        tokens = tokens.slice(2);
    }
    if (tokens.length === 0) return session.bad(cmd, 'SEARCH expects criteria');

    let predicate: Predicate;
    let scansBodies: boolean;
    try {
        const reader = new KeyReader(tokens);
        predicate = allOf(reader.all());
        scansBodies = reader.bodyScans;
    } catch (error) {
        if (error instanceof SearchSyntaxError) return session.bad(cmd, 'Invalid search criteria');
        throw error;
    }
    if (scansBodies && view.messages.length > MAX_BODY_SCANS) {
        return session.no(cmd, `Body search is limited to mailboxes of ${MAX_BODY_SCANS} messages`, 'LIMIT');
    }

    const { store } = session.ctx;
    const hits: number[] = [];
    const maxSeq = view.messages.length;
    const maxUid = view.maxUid();
    for (const [index, message] of [...view.messages].entries()) {
        let meta: Promise<MessageMeta> | null = null;
        let raw: Promise<Buffer> | null = null;
        const probe: Probe = {
            located: { seq: index + 1, message },
            maxSeq,
            maxUid,
            meta: () => (meta ??= store.readMeta(mailbox, message)),
            raw: () => (raw ??= store.readRaw(mailbox, message))
        };
        try {
            if (await predicate(probe)) hits.push(byUid ? message.uid : index + 1);
        } catch {
            // Expurgé entre-temps par une autre session : il ne correspond à rien.
        }
    }
    session.untagged(atom('SEARCH'), ...hits);
    session.ok(cmd, `${byUid ? 'UID ' : ''}SEARCH completed`);
}
