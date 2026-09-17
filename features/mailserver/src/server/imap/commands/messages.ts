import { now } from '../../_shared';
import { FLAG, OverQuotaError } from '../../engine/mailstore';
import { flagList, parseFlags, type Located } from '../mailboxView';
import { stringOf, type Command, type Token } from '../parser';
import { compactUids, parseSequenceSet, type SequenceRange } from '../sequence';
import type { CommandHandler, ImapSession } from '../session';
import { atom, parseImapDate } from '../wire';
import { fetchCommand } from './fetch';
import { findFolder } from './folders';
import { searchCommand } from './search';

/** Les commandes sur les messages du dossier ouvert, et APPEND qui n'en demande pas. */

function setOf(token: Token | undefined): SequenceRange[] | null {
    return token?.t === 'atom' ? parseSequenceSet(token.v) : null;
}

function flagNames(token: Token | undefined): string[] | null {
    if (!token) return null;
    const items = token.t === 'list' ? token.v : [token];
    const names = items.map((item) => (item.t === 'atom' ? item.v : null));
    return names.includes(null) ? null : (names as string[]);
}

async function storeCommand(session: ImapSession, cmd: Command, args: readonly Token[], byUid: boolean): Promise<void> {
    const view = session.view;
    const ranges = setOf(args[0]);
    const action = /^([+-]?)FLAGS(\.SILENT)?$/i.exec(stringOf(args[1]) ?? '');
    // Les drapeaux s'écrivent en liste, ou nus les uns après les autres.
    const names = args[2]?.t === 'list' ? flagNames(args[2]) : args.slice(2).flatMap((token) => flagNames(token) ?? []);
    const parsed = names === null ? null : parseFlags(names);
    if (!view || !ranges || !action || !parsed)
        return session.bad(cmd, 'STORE expects a message set, an action and flags');
    if (view.readOnly) return session.no(cmd, 'Mailbox is read-only');

    const [, sign, silent] = action;
    for (const { seq, message } of view.resolve(ranges, byUid)) {
        const held = message.keywords.split(' ').filter((keyword) => keyword !== '');
        let flags = message.flags;
        let keywords = held;
        if (sign === '+') {
            flags |= parsed.flags;
            keywords = [...held, ...parsed.keywords.filter((keyword) => !held.includes(keyword))];
        } else if (sign === '-') {
            flags &= ~parsed.flags;
            keywords = held.filter((keyword) => !parsed.keywords.includes(keyword));
        } else {
            flags = parsed.flags;
            keywords = parsed.keywords;
        }
        const joined = keywords.join(' ').slice(0, 255);
        if (flags !== message.flags || joined !== message.keywords) {
            message.flags = flags;
            message.keywords = joined;
            await session.ctx.store.setFlags(message, flags, joined, session.onFolderEvent);
        }
        if (!silent) {
            const item = [atom('FLAGS'), flagList(message.flags, message.keywords)];
            session.untagged(seq, atom('FETCH'), byUid ? [atom('UID'), message.uid, ...item] : item);
        }
    }
    session.ok(cmd, `${byUid ? 'UID ' : ''}STORE completed`);
}

/** Retire de la base et de la vue, en annonçant chaque `EXPUNGE` avec le numéro qu'il a À CET INSTANT. */
async function expungeLocated(session: ImapSession, targets: readonly Located[]): Promise<void> {
    const { view, mailbox } = session;
    if (!view || !mailbox) return;
    for (const { message } of targets) {
        const fresh = await session.ctx.repo.findMessage(view.folder.id, message.uid);
        if (fresh) await session.ctx.store.expunge(mailbox, fresh, session.onFolderEvent);
        const line = view.remove(message.uid);
        if (line) session.send(line);
    }
}

async function expungeCommand(session: ImapSession, cmd: Command, ranges: SequenceRange[] | null): Promise<void> {
    const view = session.view;
    if (!view) return session.bad(cmd, 'Select a mailbox first');
    if (view.readOnly) return session.no(cmd, 'Mailbox is read-only');
    const candidates = ranges
        ? view.resolve(ranges, true)
        : view.messages.map((message, index) => ({ seq: index + 1, message }));
    await expungeLocated(
        session,
        candidates.filter(({ message }) => (message.flags & FLAG.Deleted) !== 0)
    );
    session.ok(cmd, 'EXPUNGE completed');
}

async function copyCommand(
    session: ImapSession,
    cmd: Command,
    args: readonly Token[],
    byUid: boolean,
    move: boolean
): Promise<void> {
    const { view, mailbox } = session;
    const ranges = setOf(args[0]);
    if (!view || !mailbox || !ranges) return session.bad(cmd, `${cmd.name} expects a message set and a mailbox`);
    if (move && view.readOnly) return session.no(cmd, 'Mailbox is read-only');
    const target = await findFolder(session, args[1]);
    if (!target) return session.no(cmd, 'No such mailbox', 'TRYCREATE');

    const sources: Located[] = [];
    const copied: number[] = [];
    try {
        for (const located of view.resolve(ranges, byUid)) {
            const fresh = await session.ctx.repo.findMessage(view.folder.id, located.message.uid);
            if (!fresh) continue;
            const copy = await session.ctx.store.copy(mailbox, fresh, target);
            sources.push(located);
            copied.push(copy.uid);
        }
    } catch (error) {
        if (error instanceof OverQuotaError) return session.no(cmd, 'Mailbox is full', 'OVERQUOTA');
        throw error;
    }

    const code =
        sources.length === 0
            ? undefined
            : `COPYUID ${target.uid_validity} ${compactUids(sources.map((s) => s.message.uid))} ${compactUids(copied)}`;
    if (!move) return session.ok(cmd, `${byUid ? 'UID ' : ''}COPY completed`, code);

    // MOVE annonce COPYUID AVANT les EXPUNGE : après, les UID source ne désignent plus rien.
    if (code) session.untagged(atom('OK'), atom(`[${code}] Moved`));
    await expungeLocated(session, sources);
    session.ok(cmd, `${byUid ? 'UID ' : ''}MOVE completed`);
}

async function appendCommand(session: ImapSession, cmd: Command): Promise<void> {
    const mailbox = session.mailbox;
    if (!mailbox) return session.bad(cmd, 'Log in first');
    const literal = cmd.args[cmd.args.length - 1];
    if (!literal || literal.t !== 'lit') return session.bad(cmd, 'APPEND expects a message literal');
    const options = cmd.args.slice(1, -1);
    const flagToken = options.find((token) => token.t === 'list');
    const dateToken = options.find((token) => token.t === 'str');
    const parsed = parseFlags(flagToken ? (flagNames(flagToken) ?? []) : []);
    const date = dateToken ? parseImapDate(dateToken.v) : now();
    if (!parsed || date === null) return session.bad(cmd, 'Invalid flags or date');
    if (literal.v.length === 0) return session.no(cmd, 'Empty message');

    const folder = await findFolder(session, cmd.args[0]);
    if (!folder) return session.no(cmd, 'No such mailbox', 'TRYCREATE');
    try {
        const message = await session.ctx.store.append(mailbox, folder, literal.v, {
            flags: parsed.flags,
            keywords: parsed.keywords.join(' ').slice(0, 255),
            internalDate: date
        });
        session.ok(cmd, 'APPEND completed', `APPENDUID ${folder.uid_validity} ${message.uid}`);
    } catch (error) {
        if (error instanceof OverQuotaError) return session.no(cmd, 'Mailbox is full', 'OVERQUOTA');
        throw error;
    }
}

export const messageCommands: Record<string, CommandHandler> = {
    FETCH: (session, cmd) => fetchCommand(session, cmd, cmd.args, false),
    STORE: (session, cmd) => storeCommand(session, cmd, cmd.args, false),
    SEARCH: (session, cmd) => searchCommand(session, cmd, cmd.args, false),
    COPY: (session, cmd) => copyCommand(session, cmd, cmd.args, false, false),
    MOVE: (session, cmd) => copyCommand(session, cmd, cmd.args, false, true),
    EXPUNGE: (session, cmd) => expungeCommand(session, cmd, null),
    APPEND: appendCommand,

    UID: (session, cmd) => {
        const sub = stringOf(cmd.args[0])?.toUpperCase();
        const rest = cmd.args.slice(1);
        switch (sub) {
            case 'FETCH':
                return fetchCommand(session, cmd, rest, true);
            case 'STORE':
                return storeCommand(session, cmd, rest, true);
            case 'SEARCH':
                return searchCommand(session, cmd, rest, true);
            case 'COPY':
                return copyCommand(session, cmd, rest, true, false);
            case 'MOVE':
                return copyCommand(session, cmd, rest, true, true);
            case 'EXPUNGE': {
                const ranges = setOf(rest[0]);
                if (!ranges) return Promise.resolve(session.bad(cmd, 'UID EXPUNGE expects a UID set'));
                return expungeCommand(session, cmd, ranges);
            }
            default:
                return Promise.resolve(session.bad(cmd, 'Unknown UID command'));
        }
    }
};
