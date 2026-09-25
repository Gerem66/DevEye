import type { Socket } from 'node:net';

import type { SdkLogger } from '@deveye/types/sdk/server';

import type { Authenticator } from '../engine/auth';
import type { MailStore } from '../engine/mailstore';
import type { FolderEvent, Notifier } from '../engine/notifier';
import type { FolderRow, MailboxRow, MailserverRepo } from '../repo';
import { folderCommands } from './commands/folders';
import { messageCommands } from './commands/messages';
import { MailboxView } from './mailboxView';
import { CommandReader, ParseError, parseCommand, stringOf, utf8Of, type Command, type Segment } from './parser';
import { atom, tagged, untagged, type ImapValue } from './wire';

/**
 * Une connexion IMAP : l'état du protocole, et la commande en cours. Les
 * commandes s'exécutent une à la fois, dans l'ordre d'arrivée : IMAP autorise
 * le pipeline, mais pas les réponses entremêlées.
 */

export interface ImapContext {
    repo: MailserverRepo;
    store: MailStore;
    auth: Authenticator;
    notifier: Notifier;
    hostname: string;
    maxMessageBytes: number;
    logger: SdkLogger;
}

/**
 * Seulement ce qui est réellement servi. Un client n'envoie que ce qu'il lit
 * ici : ne pas annoncer ENABLE, CONDSTORE ou COMPRESS suffit à ne jamais les
 * recevoir.
 */
export function capabilities(maxMessageBytes: number): string {
    return `IMAP4rev1 LITERAL+ SASL-IR AUTH=PLAIN ID NAMESPACE UIDPLUS MOVE IDLE SPECIAL-USE UNSELECT CHILDREN APPENDLIMIT=${maxMessageBytes}`;
}

const PREAUTH_TIMEOUT_MS = 60_000;
const AUTH_TIMEOUT_MS = 30 * 60_000;
const MAX_LINE = 64 * 1024;
/** Avant l'authentification, un littéral ne porte qu'un identifiant ou un mot de passe. */
const PREAUTH_MAX_LITERAL = 4 * 1024;

export type CommandHandler = (session: ImapSession, cmd: Command) => Promise<void>;

type State = 'notauth' | 'auth' | 'selected' | 'logout';

export class ImapSession {
    state: State = 'notauth';
    mailbox: MailboxRow | null = null;
    view: MailboxView | null = null;

    private chain: Promise<void> = Promise.resolve();
    private continuation: ((line: string) => Promise<void>) | null = null;
    private idling = false;
    private unwatchFolder: (() => void) | null = null;
    private unwatchMailbox: (() => void) | null = null;
    private readonly reader: CommandReader;
    /** Le même objet tout au long de la session : c'est lui que `except` reconnaît. */
    readonly onFolderEvent = (event: FolderEvent): void => {
        if (!this.view) return;
        this.view.queue(event);
        if (this.idling) this.flush();
    };

    constructor(
        private readonly socket: Socket,
        readonly ctx: ImapContext,
        readonly ip: string
    ) {
        this.reader = new CommandReader(
            { maxLine: MAX_LINE, maxLiteral: PREAUTH_MAX_LITERAL },
            {
                onLine: (segments) => this.enqueue(segments),
                onContinue: () => this.send(Buffer.from('+ OK\r\n')),
                onOverflow: (reason) => {
                    this.send(
                        untagged(atom('BYE'), atom(reason === 'line' ? 'Line too long' : '[TOOBIG] Literal too large'))
                    );
                    this.close();
                }
            }
        );
        socket.setTimeout(PREAUTH_TIMEOUT_MS, () => {
            this.send(untagged(atom('BYE'), atom('Autologout, idle for too long')));
            this.close();
        });
        socket.on('data', (chunk: Buffer) => this.reader.feed(chunk));
        socket.on('error', () => this.close());
        socket.on('close', () => this.release());
        this.send(
            untagged(atom('OK'), atom(`[CAPABILITY ${capabilities(ctx.maxMessageBytes)}] ${ctx.hostname} IMAP ready`))
        );
    }

    send(data: Buffer): void {
        if (!this.socket.destroyed && this.socket.writable) this.socket.write(data);
    }

    /** Attend que le tampon d'écriture se vide : un FETCH de dix mille messages ne s'empile pas en mémoire. */
    async drain(): Promise<void> {
        if (this.socket.destroyed || this.socket.writableLength < 1024 * 1024) return;
        await new Promise<void>((resolve) => {
            const done = (): void => {
                this.socket.off('drain', done);
                this.socket.off('close', done);
                resolve();
            };
            this.socket.once('drain', done);
            this.socket.once('close', done);
        });
    }

    ok(cmd: Command, text: string, code?: string): void {
        this.send(tagged(cmd.tag, 'OK', text, code));
    }

    no(cmd: Command, text: string, code?: string): void {
        this.send(tagged(cmd.tag, 'NO', text, code));
    }

    bad(cmd: Command, text: string): void {
        this.send(tagged(cmd.tag, 'BAD', text));
    }

    untagged(...values: ImapValue[]): void {
        this.send(untagged(...values));
    }

    /** Annonce au client ce que d'autres ont fait au dossier ouvert. */
    flush(): void {
        if (!this.view?.hasPending()) return;
        for (const line of this.view.flush()) this.send(line);
    }

    /** La prochaine ligne du client n'est pas une commande : c'est la suite de celle-ci. */
    expectContinuation(prompt: string, handler: (line: string) => Promise<void>): void {
        this.continuation = handler;
        this.send(Buffer.from(`+ ${prompt}\r\n`));
    }

    async open(folder: FolderRow, readOnly: boolean): Promise<MailboxView> {
        this.unselect();
        const view = new MailboxView(folder, readOnly, await this.ctx.repo.listMessages(folder.id));
        this.view = view;
        this.state = 'selected';
        this.unwatchFolder = this.ctx.notifier.watchFolder(folder.id, this.onFolderEvent);
        return view;
    }

    unselect(): void {
        this.unwatchFolder?.();
        this.unwatchFolder = null;
        this.view = null;
        if (this.state === 'selected') this.state = 'auth';
    }

    authenticated(mailbox: MailboxRow): void {
        this.mailbox = mailbox;
        this.state = 'auth';
        this.socket.setTimeout(AUTH_TIMEOUT_MS);
        this.reader.setLimits({ maxLine: MAX_LINE, maxLiteral: this.ctx.maxMessageBytes });
        // Boîte éteinte, mise en pause par l'offre, supprimée, ou mot de passe changé : la session ne survit pas.
        this.unwatchMailbox = this.ctx.notifier.watchMailbox(mailbox.id, () => {
            this.send(untagged(atom('BYE'), atom('Session closed by the server')));
            this.close();
        });
    }

    close(): void {
        this.state = 'logout';
        this.socket.end();
        // Un pair qui ne ferme pas de son côté ne retient pas la socket.
        setTimeout(() => this.socket.destroy(), 1_000).unref();
    }

    destroy(): void {
        this.send(untagged(atom('BYE'), atom('Server shutting down')));
        this.socket.destroy();
    }

    private release(): void {
        this.unselect();
        this.unwatchMailbox?.();
        this.unwatchMailbox = null;
        this.state = 'logout';
    }

    private enqueue(segments: Segment[]): void {
        this.chain = this.chain
            .then(() => this.dispatch(segments))
            .catch((error: unknown) => {
                this.ctx.logger.error({ err: (error as Error).message }, 'IMAP : commande interrompue');
            });
    }

    private async dispatch(segments: Segment[]): Promise<void> {
        if (this.state === 'logout') return;

        if (this.continuation) {
            const handler = this.continuation;
            this.continuation = null;
            await handler(typeof segments[0] === 'string' ? segments[0] : '');
            return;
        }

        let cmd: Command;
        try {
            cmd = parseCommand(segments);
        } catch (error) {
            const first = typeof segments[0] === 'string' ? segments[0].split(' ')[0] : '';
            const tag = /^[^\s+*%"\\{(]+$/.test(first) ? first : '*';
            this.send(
                Buffer.from(`${tag} BAD ${error instanceof ParseError ? 'Syntax error' : 'Unreadable command'}\r\n`)
            );
            return;
        }

        // Une commande par UID ne dépend d'aucun numéro de séquence : ce qui attendait peut être dit avant elle,
        // et elle voit alors le courrier arrivé depuis l'ouverture du dossier.
        if (cmd.name === 'UID') this.flush();
        try {
            await this.run(cmd);
        } catch (error) {
            this.ctx.logger.error({ err: (error as Error).message, command: cmd.name }, 'IMAP : échec d’une commande');
            this.no(cmd, 'Internal error');
        }
        // FETCH, STORE et SEARCH par numéro de séquence ne doivent pas voir ces numéros bouger sous eux.
        if (!['FETCH', 'STORE', 'SEARCH'].includes(cmd.name)) this.flush();
    }

    private async run(cmd: Command): Promise<void> {
        const handler = ANY_STATE[cmd.name];
        if (handler) return handler(this, cmd);

        if (this.state === 'notauth') {
            const pre = NOT_AUTHENTICATED[cmd.name];
            if (pre) return pre(this, cmd);
            return this.bad(cmd, 'Log in first');
        }

        if (cmd.name === 'IDLE') return this.idle(cmd);
        const authed = folderCommands[cmd.name];
        if (authed) return authed(this, cmd);

        const selected = messageCommands[cmd.name];
        if (selected) {
            if (cmd.name !== 'APPEND' && this.state !== 'selected') return this.bad(cmd, 'Select a mailbox first');
            return selected(this, cmd);
        }
        return this.bad(cmd, 'Unknown command');
    }

    private idle(cmd: Command): Promise<void> {
        this.idling = true;
        this.expectContinuation('idling', (line) => {
            this.idling = false;
            if (line.trim().toUpperCase() === 'DONE') this.ok(cmd, 'IDLE terminated');
            else this.bad(cmd, 'Expected DONE');
            return Promise.resolve();
        });
        this.flush();
        return Promise.resolve();
    }
}

/** `\0identité\0secret`, ou `autorisation\0identité\0secret` : seule l'identité compte ici. */
function parsePlain(encoded: string): { user: string; secret: string } | null {
    const parts = Buffer.from(encoded, 'base64').toString('utf8').split('\0');
    if (parts.length !== 3 || parts[1] === '' || parts[2] === '') return null;
    return { user: parts[1], secret: parts[2] };
}

async function login(session: ImapSession, cmd: Command, user: string, secret: string): Promise<void> {
    const outcome = await session.ctx.auth.login(user, secret, session.ip, 'IMAP');
    if (!outcome.ok) {
        return session.no(
            cmd,
            outcome.reason === 'throttled' ? 'Too many failed attempts, try again later' : 'Invalid credentials',
            'AUTHENTICATIONFAILED'
        );
    }
    session.authenticated(outcome.mailbox);
    session.ok(cmd, 'Logged in', `CAPABILITY ${capabilities(session.ctx.maxMessageBytes)}`);
}

const ANY_STATE: Record<string, CommandHandler> = {
    CAPABILITY: (session, cmd) => {
        session.untagged(atom('CAPABILITY'), atom(capabilities(session.ctx.maxMessageBytes)));
        session.ok(cmd, 'CAPABILITY completed');
        return Promise.resolve();
    },
    NOOP: (session, cmd) => {
        session.ok(cmd, 'NOOP completed');
        return Promise.resolve();
    },
    LOGOUT: (session, cmd) => {
        session.untagged(atom('BYE'), atom('Logging out'));
        session.ok(cmd, 'LOGOUT completed');
        session.close();
        return Promise.resolve();
    },
    ID: (session, cmd) => {
        session.untagged(atom('ID'), ['name', 'DevEye', 'vendor', 'DevEye']);
        session.ok(cmd, 'ID completed');
        return Promise.resolve();
    }
};

const NOT_AUTHENTICATED: Record<string, CommandHandler> = {
    LOGIN: async (session, cmd) => {
        const user = stringOf(cmd.args[0]);
        const secret = stringOf(cmd.args[1]);
        if (user === null || secret === null) return session.bad(cmd, 'LOGIN expects a user and a password');
        await login(session, cmd, utf8Of(user), utf8Of(secret));
    },
    AUTHENTICATE: async (session, cmd) => {
        if (stringOf(cmd.args[0])?.toUpperCase() !== 'PLAIN') return session.no(cmd, 'Unsupported mechanism');
        const finish = async (encoded: string): Promise<void> => {
            if (encoded.trim() === '*') return session.bad(cmd, 'Authentication cancelled');
            const plain = parsePlain(encoded.trim());
            if (!plain) return session.bad(cmd, 'Unreadable credentials');
            await login(session, cmd, plain.user, plain.secret);
        };
        // SASL-IR : la réponse peut arriver avec la commande, `=` valant « vide ».
        const initial = stringOf(cmd.args[1]);
        if (initial !== null && initial !== '=') return finish(initial);
        session.expectContinuation('', finish);
    }
};
