import { FLAG } from '../../engine/mailstore';
import type { FolderRow } from '../../repo';
import { stringOf, utf8Of, type Command, type Token } from '../parser';
import type { CommandHandler, ImapSession } from '../session';
import { decodeUtf7, encodeUtf7 } from '../utf7';
import { atom, type ImapValue } from '../wire';

/** Les commandes sur les dossiers d'une boîte : lister, créer, ouvrir, fermer. */

export const DELIMITER = '/';
const MAX_PATH = 200;
const MAX_FOLDERS = 500;

/** Le nom d'un dossier tel que la base le tient : décodé, et `INBOX` quelle que soit sa casse. */
export function folderPath(token: Token | undefined): string | null {
    const raw = stringOf(token);
    if (raw === null) return null;
    const path = decodeUtf7(utf8Of(raw)).replace(/\/+$/, '');
    return path.toUpperCase() === 'INBOX' ? 'INBOX' : path;
}

export async function findFolder(session: ImapSession, token: Token | undefined): Promise<FolderRow | null> {
    const path = folderPath(token);
    if (path === null || !session.mailbox) return null;
    return session.ctx.repo.findFolder(session.mailbox.id, path);
}

/** Un motif de LIST en expression régulière : `*` traverse la hiérarchie, `%` s'arrête au délimiteur. */
function patternOf(pattern: string): RegExp {
    const body = pattern
        .split('')
        .map((char) => (char === '*' ? '.*' : char === '%' ? '[^/]*' : char.replace(/[.+?^${}()|[\]\\]/g, '\\$&')))
        .join('');
    return new RegExp(`^${body}$`);
}

async function listed(session: ImapSession, cmd: Command, onlySubscribed: boolean): Promise<void> {
    {
        const reference = folderPath(cmd.args[0]) ?? '';
        const rawPattern = stringOf(cmd.args[1]);
        if (rawPattern === null || !session.mailbox)
            return session.bad(cmd, `${cmd.name} expects a reference and a pattern`);
        const name = atom(cmd.name);

        // Motif vide : le client demande le délimiteur, pas des dossiers.
        if (rawPattern === '') {
            session.untagged(name, [atom('\\Noselect')], DELIMITER, '');
            return session.ok(cmd, `${cmd.name} completed`);
        }

        const decoded = decodeUtf7(utf8Of(rawPattern));
        const prefix = reference === '' ? '' : `${reference}${DELIMITER}`;
        const matcher = patternOf(`${prefix}${decoded}`.replace(/^inbox(?=$|\/)/i, 'INBOX'));
        const folders = await session.ctx.repo.listFolders(session.mailbox.id);
        for (const folder of folders) {
            if (!matcher.test(folder.path)) continue;
            if (onlySubscribed && folder.subscribed !== 1) continue;
            const flags: ImapValue[] = [
                atom(
                    folders.some((other) => other.path.startsWith(`${folder.path}${DELIMITER}`))
                        ? '\\HasChildren'
                        : '\\HasNoChildren'
                )
            ];
            if (folder.special_use) flags.push(atom(folder.special_use));
            session.untagged(name, flags, DELIMITER, encodeUtf7(folder.path));
        }
        session.ok(cmd, `${cmd.name} completed`);
    }
}

async function openFolder(session: ImapSession, cmd: Command, readOnly: boolean): Promise<void> {
    const folder = await findFolder(session, cmd.args[0]);
    if (!folder) {
        session.unselect();
        return session.no(cmd, 'No such mailbox', 'NONEXISTENT');
    }
    const view = await session.open(folder, readOnly);
    const flags = ['\\Answered', '\\Flagged', '\\Deleted', '\\Seen', '\\Draft'].map(atom);
    session.untagged(atom('FLAGS'), flags);
    session.untagged(
        atom('OK'),
        atom(
            `[PERMANENTFLAGS (${readOnly ? '' : '\\Answered \\Flagged \\Deleted \\Seen \\Draft \\*'})] Flags permitted`
        )
    );
    session.untagged(view.messages.length, atom('EXISTS'));
    session.untagged(0, atom('RECENT'));
    const unseen = view.firstUnseen();
    if (unseen !== null) session.untagged(atom('OK'), atom(`[UNSEEN ${unseen}] First unseen`));
    session.untagged(atom('OK'), atom(`[UIDVALIDITY ${folder.uid_validity}] UIDs valid`));
    session.untagged(atom('OK'), atom(`[UIDNEXT ${folder.uid_next}] Predicted next UID`));
    session.ok(cmd, `${cmd.name} completed`, readOnly ? 'READ-ONLY' : 'READ-WRITE');
}

export const folderCommands: Record<string, CommandHandler> = {
    NAMESPACE: (session, cmd) => {
        session.untagged(atom('NAMESPACE'), [['', DELIMITER]], null, null);
        session.ok(cmd, 'NAMESPACE completed');
        return Promise.resolve();
    },

    LIST: (session, cmd) => listed(session, cmd, false),
    LSUB: (session, cmd) => listed(session, cmd, true),

    CREATE: async (session, cmd) => {
        const path = folderPath(cmd.args[0]);
        if (path === null || !session.mailbox) return session.bad(cmd, 'CREATE expects a mailbox name');
        if (path === '' || path.length > MAX_PATH || path.split(DELIMITER).some((part) => part.trim() === '')) {
            return session.no(cmd, 'Invalid mailbox name', 'CANNOT');
        }
        const { repo } = session.ctx;
        const existing = await repo.listFolders(session.mailbox.id);
        if (existing.some((folder) => folder.path === path))
            return session.no(cmd, 'Mailbox already exists', 'ALREADYEXISTS');
        if (existing.length >= MAX_FOLDERS) return session.no(cmd, 'Too many mailboxes', 'LIMIT');
        // Les parents manquants sont créés avec lui : un dossier orphelin n'apparaîtrait pas dans l'arbre des clients.
        const parts = path.split(DELIMITER);
        for (let depth = 1; depth <= parts.length; depth += 1) {
            const ancestor = parts.slice(0, depth).join(DELIMITER);
            if (existing.some((folder) => folder.path === ancestor)) continue;
            await repo.createFolder({
                mailboxId: session.mailbox.id,
                path: ancestor,
                specialUse: null,
                uidValidity: await repo.nextUidValidity(session.mailbox.id)
            });
        }
        session.ok(cmd, 'CREATE completed');
    },

    DELETE: async (session, cmd) => {
        const folder = await findFolder(session, cmd.args[0]);
        if (!folder || !session.mailbox) return session.no(cmd, 'No such mailbox', 'NONEXISTENT');
        if (folder.path === 'INBOX') return session.no(cmd, 'INBOX cannot be deleted', 'CANNOT');
        const siblings = await session.ctx.repo.listFolders(session.mailbox.id);
        if (siblings.some((other) => other.path.startsWith(`${folder.path}${DELIMITER}`))) {
            return session.no(cmd, 'Mailbox has children, delete them first', 'HASCHILDREN');
        }
        if (session.view?.folder.id === folder.id) session.unselect();
        await session.ctx.store.deleteFolder(session.mailbox, folder);
        session.ok(cmd, 'DELETE completed');
    },

    RENAME: async (session, cmd) => {
        const folder = await findFolder(session, cmd.args[0]);
        const target = folderPath(cmd.args[1]);
        if (!folder || !session.mailbox) return session.no(cmd, 'No such mailbox', 'NONEXISTENT');
        if (target === null || target === '' || target.length > MAX_PATH)
            return session.no(cmd, 'Invalid mailbox name', 'CANNOT');
        if (folder.path === 'INBOX' || target === 'INBOX') return session.no(cmd, 'INBOX cannot be renamed', 'CANNOT');
        const { repo } = session.ctx;
        const all = await repo.listFolders(session.mailbox.id);
        if (all.some((other) => other.path === target))
            return session.no(cmd, 'Mailbox already exists', 'ALREADYEXISTS');
        for (const other of all) {
            if (other.id === folder.id) await repo.renameFolder(other.id, target);
            else if (other.path.startsWith(`${folder.path}${DELIMITER}`)) {
                await repo.renameFolder(other.id, `${target}${other.path.slice(folder.path.length)}`);
            }
        }
        if (session.view?.folder.id === folder.id) session.view.folder = { ...session.view.folder, path: target };
        session.ok(cmd, 'RENAME completed');
    },

    SUBSCRIBE: async (session, cmd) => {
        const folder = await findFolder(session, cmd.args[0]);
        if (!folder) return session.no(cmd, 'No such mailbox', 'NONEXISTENT');
        await session.ctx.repo.setSubscribed(folder.id, true);
        session.ok(cmd, 'SUBSCRIBE completed');
    },

    UNSUBSCRIBE: async (session, cmd) => {
        const folder = await findFolder(session, cmd.args[0]);
        if (!folder) return session.no(cmd, 'No such mailbox', 'NONEXISTENT');
        await session.ctx.repo.setSubscribed(folder.id, false);
        session.ok(cmd, 'UNSUBSCRIBE completed');
    },

    STATUS: async (session, cmd) => {
        const folder = await findFolder(session, cmd.args[0]);
        const items = cmd.args[1];
        if (!items || items.t !== 'list') return session.bad(cmd, 'STATUS expects a list of items');
        if (!folder) return session.no(cmd, 'No such mailbox', 'NONEXISTENT');
        const messages = await session.ctx.repo.listMessages(folder.id);
        const out: ImapValue[] = [];
        for (const item of items.v) {
            const name = stringOf(item)?.toUpperCase();
            const value =
                name === 'MESSAGES'
                    ? messages.length
                    : name === 'RECENT'
                      ? 0
                      : name === 'UIDNEXT'
                        ? folder.uid_next
                        : name === 'UIDVALIDITY'
                          ? folder.uid_validity
                          : name === 'UNSEEN'
                            ? messages.filter((m) => (m.flags & FLAG.Seen) === 0).length
                            : null;
            if (name === undefined || value === null) return session.bad(cmd, 'Unknown STATUS item');
            out.push(atom(name), value);
        }
        session.untagged(atom('STATUS'), encodeUtf7(folder.path), out);
        session.ok(cmd, 'STATUS completed');
    },

    SELECT: (session, cmd) => openFolder(session, cmd, false),
    EXAMINE: (session, cmd) => openFolder(session, cmd, true),

    CHECK: (session, cmd) => {
        if (session.state !== 'selected') return Promise.resolve(session.bad(cmd, 'Select a mailbox first'));
        session.ok(cmd, 'CHECK completed');
        return Promise.resolve();
    },

    UNSELECT: (session, cmd) => {
        if (session.state !== 'selected') return Promise.resolve(session.bad(cmd, 'Select a mailbox first'));
        session.unselect();
        session.ok(cmd, 'UNSELECT completed');
        return Promise.resolve();
    },

    // Ferme en expurgeant, sans rien en dire : c'est ce qui distingue CLOSE de EXPUNGE puis UNSELECT.
    CLOSE: async (session, cmd) => {
        const view = session.view;
        if (!view || !session.mailbox) return session.bad(cmd, 'Select a mailbox first');
        if (!view.readOnly) {
            for (const message of view.messages.filter((m) => (m.flags & FLAG.Deleted) !== 0)) {
                const fresh = await session.ctx.repo.findMessage(view.folder.id, message.uid);
                if (fresh) await session.ctx.store.expunge(session.mailbox, fresh, session.onFolderEvent);
            }
        }
        session.unselect();
        session.ok(cmd, 'CLOSE completed');
    }
};
