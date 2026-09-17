import { FLAG, type MessageMeta } from '../../engine/mailstore';
import { buildBodyStructure } from '../../mime/bodystructure';
import { buildEnvelope } from '../../mime/envelope';
import { extractSection, parseSection, slicePartial, type SectionSpec } from '../../mime/sections';
import type { MessageRow } from '../../repo';
import { flagList, type Located } from '../mailboxView';
import type { Command, Token } from '../parser';
import { parseSequenceSet } from '../sequence';
import type { ImapSession } from '../session';
import { atom, formatInternalDate, untagged, type ImapValue } from '../wire';

/** FETCH : ce qu'un client demande d'un message, et la réponse qui le lui rend. */

type FetchItem =
    | { kind: 'uid' | 'flags' | 'internaldate' | 'size' | 'envelope' | 'bodystructure' | 'body' }
    | { kind: 'rfc822' | 'rfc822.header' | 'rfc822.text' }
    | {
          kind: 'section';
          peek: boolean;
          spec: SectionSpec;
          /** Le texte de la section tel que le client l'a écrit : la réponse le lui renvoie. */
          label: string;
          partial: { start: number; length: number } | null;
      };

const MACROS: Record<string, string[]> = {
    ALL: ['FLAGS', 'INTERNALDATE', 'RFC822.SIZE', 'ENVELOPE'],
    FAST: ['FLAGS', 'INTERNALDATE', 'RFC822.SIZE'],
    FULL: ['FLAGS', 'INTERNALDATE', 'RFC822.SIZE', 'ENVELOPE', 'BODY']
};

const SIMPLE: Record<string, FetchItem> = {
    UID: { kind: 'uid' },
    FLAGS: { kind: 'flags' },
    INTERNALDATE: { kind: 'internaldate' },
    'RFC822.SIZE': { kind: 'size' },
    ENVELOPE: { kind: 'envelope' },
    BODYSTRUCTURE: { kind: 'bodystructure' },
    BODY: { kind: 'body' },
    RFC822: { kind: 'rfc822' },
    'RFC822.HEADER': { kind: 'rfc822.header' },
    'RFC822.TEXT': { kind: 'rfc822.text' }
};

function parseItem(text: string): FetchItem | null {
    const simple = SIMPLE[text.toUpperCase()];
    if (simple) return simple;
    const m = /^BODY(\.PEEK)?\[(.*)\](?:<(\d+)\.(\d+)>)?$/i.exec(text);
    if (!m) return null;
    const spec = parseSection(m[2]);
    if (!spec) return null;
    const partial = m[3] === undefined ? null : { start: Number(m[3]), length: Number(m[4]) };
    if (partial && partial.length === 0) return null;
    return { kind: 'section', peek: m[1] !== undefined, spec, label: m[2], partial };
}

export function parseFetchItems(token: Token | undefined): FetchItem[] | null {
    if (!token) return null;
    const names =
        token.t === 'list'
            ? token.v.map((item) => (item.t === 'atom' ? item.v : null))
            : token.t === 'atom'
              ? (MACROS[token.v.toUpperCase()] ?? [token.v])
              : null;
    if (names === null || names.length === 0 || names.includes(null)) return null;
    const items = (names as string[]).map(parseItem);
    return items.includes(null) ? null : (items as FetchItem[]);
}

/** Ce que l'item lit du message entier, et pas seulement de ses en-têtes déjà gardés dans `meta`. */
const needsRaw = (item: FetchItem): boolean =>
    item.kind === 'rfc822' ||
    item.kind === 'rfc822.text' ||
    (item.kind === 'section' && !(item.spec.path.length === 0 && item.spec.part.startsWith('HEADER')));

const needsMeta = (item: FetchItem): boolean =>
    ['envelope', 'bodystructure', 'body', 'rfc822.header', 'rfc822.text', 'section'].includes(item.kind);

const marksSeen = (item: FetchItem): boolean =>
    item.kind === 'rfc822' || item.kind === 'rfc822.text' || (item.kind === 'section' && !item.peek);

async function respond(
    session: ImapSession,
    located: Located,
    items: readonly FetchItem[],
    byUid: boolean
): Promise<Buffer | null> {
    const { mailbox, view } = session;
    if (!mailbox || !view) return null;
    const message: MessageRow = located.message;
    const { store } = session.ctx;

    let meta: MessageMeta | null = null;
    let raw: Buffer | null = null;
    try {
        if (items.some(needsMeta)) meta = await store.readMeta(mailbox, message);
        if (items.some(needsRaw)) raw = await store.readRaw(mailbox, message);
    } catch {
        // Expurgé par une autre session depuis l'ouverture de la vue : il n'y a plus rien à rendre.
        return null;
    }
    const head = meta ? Buffer.from(meta.head, 'latin1') : null;

    let flagsShown = false;
    if (!view.readOnly && (message.flags & FLAG.Seen) === 0 && items.some(marksSeen)) {
        message.flags |= FLAG.Seen;
        await store.setFlags(message, message.flags, message.keywords, session.onFolderEvent);
        flagsShown = true;
    }

    const out: ImapValue[] = [];
    const push = (name: string, value: ImapValue): void => {
        out.push(atom(name), value);
    };
    for (const item of items) {
        switch (item.kind) {
            case 'uid':
                break;
            case 'flags':
                flagsShown = true;
                break;
            case 'internaldate':
                push('INTERNALDATE', formatInternalDate(message.internal_date));
                break;
            case 'size':
                push('RFC822.SIZE', message.size);
                break;
            case 'envelope':
                if (meta) push('ENVELOPE', buildEnvelope(meta.tree.headers ?? []));
                break;
            case 'bodystructure':
                if (meta) push('BODYSTRUCTURE', buildBodyStructure(meta.tree, true));
                break;
            case 'body':
                if (meta) push('BODY', buildBodyStructure(meta.tree, false));
                break;
            case 'rfc822':
                if (raw) push('RFC822', { literal: raw });
                break;
            case 'rfc822.header':
                if (head) push('RFC822.HEADER', { literal: head });
                break;
            case 'rfc822.text':
                if (raw && meta) push('RFC822.TEXT', { literal: raw.subarray(meta.tree.bodyStart) });
                break;
            case 'section': {
                if (!meta) break;
                // Sans le corps sous la main, les en-têtes gardés suffisent à la sélection demandée.
                const source = raw ?? head ?? Buffer.alloc(0);
                const data = extractSection(source, meta.tree, item.spec);
                const label = `BODY[${item.label.trim()}]${item.partial ? `<${item.partial.start}>` : ''}`;
                push(label, data === null ? null : { literal: slicePartial(data, item.partial) });
                break;
            }
        }
    }
    if (flagsShown) out.unshift(atom('FLAGS'), flagList(message.flags, message.keywords));
    if (byUid || items.some((item) => item.kind === 'uid')) out.unshift(atom('UID'), message.uid);
    return untagged(located.seq, atom('FETCH'), out);
}

export async function fetchCommand(
    session: ImapSession,
    cmd: Command,
    args: readonly Token[],
    byUid: boolean
): Promise<void> {
    const view = session.view;
    const set = args[0]?.t === 'atom' ? args[0].v : null;
    const items = parseFetchItems(args[1]);
    if (!view || set === null || items === null) return session.bad(cmd, 'FETCH expects a message set and items');
    const ranges = parseSequenceSet(set);
    if (!ranges) return session.bad(cmd, 'Invalid message set');

    for (const located of view.resolve(ranges, byUid)) {
        const line = await respond(session, located, items, byUid);
        if (line) session.send(line);
        await session.drain();
    }
    session.ok(cmd, `${byUid ? 'UID ' : ''}FETCH completed`);
}
