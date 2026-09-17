import crypto from 'node:crypto';

import type { SdkCipher, SdkLogger } from '@deveye/types/sdk/server';
import addressparser from 'nodemailer/lib/addressparser';
import { SMTPServer } from 'smtp-server';

import { dayOf, now, seal } from '../_shared';
import type { Authenticator } from '../engine/auth';
import { IpLimiter, SlidingCounter } from '../engine/limits';
import { FLAG, type MailStore } from '../engine/mailstore';
import type { TlsStore } from '../engine/tls';
import { headerOf, parseHeaders } from '../mime/tree';
import type { MailserverRepo } from '../repo';
import type { SmtpListener } from './inbound';
import { close, collect, followCertificate, listen, receivedHeader, smtpError, tlsOptions } from './shared';

/**
 * La soumission : le courrier qu'un client authentifié confie au serveur pour
 * l'envoyer. Deux ports, un seul comportement : 465 chiffre dès la connexion,
 * 587 exige STARTTLS avant toute authentification.
 *
 * Une boîte n'écrit que sous son propre nom, et pas plus vite que ses plafonds :
 * un mot de passe volé ne doit pas faire du serveur un canon à spam, dont la
 * réputation est commune à tous les espaces.
 */

const MAX_RECIPIENTS = 50;
const HOURLY_RECIPIENTS = 100;

export interface SubmissionDeps {
    hostname: string;
    maxBytes: number;
    certificates: TlsStore;
    repo: MailserverRepo;
    store: MailStore;
    auth: Authenticator;
    cipherFor(workspaceId: number): SdkCipher;
    /** La file vient de grossir : inutile d'attendre son prochain tour. */
    kick(): void;
    logger: SdkLogger;
}

interface SessionUser {
    mailboxId: number;
    saveSent: boolean;
}

export function createSubmissionServer(deps: SubmissionDeps, implicitTls: boolean): SmtpListener {
    const limiter = new IpLimiter(10, 60);
    const hourly = new SlidingCounter(3_600_000);

    const server = new SMTPServer({
        name: deps.hostname,
        banner: 'DevEye',
        size: deps.maxBytes,
        secure: implicitTls,
        ...tlsOptions(deps.certificates),
        authMethods: ['PLAIN', 'LOGIN'],
        // Jamais de mot de passe sur une connexion en clair : `AUTH` n'existe qu'après STARTTLS.
        allowInsecureAuth: false,
        disableReverseLookup: true,
        maxClients: 100,
        socketTimeout: 120_000,
        closeTimeout: 1_000,
        logger: false,

        onConnect(session, done) {
            if (!limiter.admit(session.remoteAddress, Date.now())) {
                return done(smtpError(421, 'Too many connections from your address, try again later'));
            }
            done();
        },

        onClose(session) {
            limiter.release(session.remoteAddress);
        },

        onAuth(auth, session, done) {
            deps.auth
                .login(auth.username ?? '', auth.password ?? '', session.remoteAddress, 'SMTP')
                .then((outcome) => {
                    if (!outcome.ok) {
                        return done(
                            smtpError(
                                outcome.reason === 'throttled' ? 454 : 535,
                                outcome.reason === 'throttled'
                                    ? '4.7.0 Too many failed attempts, try again later'
                                    : '5.7.8 Invalid credentials'
                            )
                        );
                    }
                    const user: SessionUser = {
                        mailboxId: outcome.mailbox.id,
                        saveSent: outcome.credential?.save_sent === 1
                    };
                    done(null, { user });
                })
                .catch((error: unknown) => {
                    deps.logger.error({ err: (error as Error).message }, 'Soumission : authentification interrompue');
                    done(smtpError(454, '4.7.0 Temporary authentication failure'));
                });
        },

        onMailFrom(address, session, done) {
            const user = session.user as unknown as SessionUser | undefined;
            if (!user) return done(smtpError(530, '5.7.0 Authentication required'));
            deps.repo
                .findById(user.mailboxId)
                .then((mailbox) => {
                    if (!mailbox || mailbox.enabled !== 1) return done(smtpError(535, '5.7.8 Mailbox disabled'));
                    if (address.address.toLowerCase() !== mailbox.address) {
                        return done(smtpError(553, `5.7.1 You may only send as ${mailbox.address}`));
                    }
                    done();
                })
                .catch(() => done(smtpError(451, '4.3.0 Temporary failure, try again later')));
        },

        onRcptTo(address, session, done) {
            if (session.envelope.rcptTo.length >= MAX_RECIPIENTS) return done(smtpError(452, 'Too many recipients'));
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address.address))
                return done(smtpError(553, '5.1.3 Bad recipient address'));
            done();
        },

        onData(stream, session, done) {
            const user = session.user as unknown as SessionUser | undefined;
            void (async () => {
                const body = await collect(stream, deps.maxBytes);
                if (body === null) throw smtpError(552, '5.3.4 Message too large');
                const mailbox = user ? await deps.repo.findById(user.mailboxId) : null;
                if (!user || !mailbox || mailbox.enabled !== 1) throw smtpError(530, '5.7.0 Authentication required');

                const recipients = [...new Set(session.envelope.rcptTo.map((rcpt) => rcpt.address.toLowerCase()))];
                if (recipients.length === 0) throw smtpError(554, '5.5.1 No valid recipients');

                // L'enveloppe ne suffit pas : c'est le `From:` de l'en-tête que le destinataire lit.
                const headers = parseHeaders(body.toString('latin1', 0, Math.min(body.length, 64 * 1024)));
                const authors = (addressparser(headerOf(headers, 'from') ?? '') as { address?: string }[])
                    .map((entry) => (entry.address ?? '').toLowerCase())
                    .filter((address) => address !== '');
                if (authors.length !== 1 || authors[0] !== mailbox.address) {
                    throw smtpError(553, `5.7.1 The From header must be ${mailbox.address}`);
                }

                const nowMs = Date.now();
                const sentToday = await deps.repo.sentOn(mailbox.id, dayOf(now()));
                const queued = await deps.repo.queueCounts(mailbox.id);
                if (
                    hourly.count(mailbox.id, nowMs) + recipients.length > HOURLY_RECIPIENTS ||
                    sentToday + queued.queued + queued.deferred + recipients.length > mailbox.outbound_daily_limit
                ) {
                    throw smtpError(450, '4.7.1 Sending limit reached for this mailbox, try again later');
                }

                let prefix = receivedHeader({
                    helo: session.hostNameAppearsAs,
                    ip: session.remoteAddress,
                    hostname: deps.hostname,
                    protocol: 'ESMTPSA',
                    id: session.id
                });
                if (headerOf(headers, 'message-id') === null) {
                    prefix += `Message-ID: <${crypto.randomUUID()}@${deps.hostname}>\r\n`;
                }
                if (headerOf(headers, 'date') === null) {
                    prefix += `Date: ${new Date().toUTCString().replace('GMT', '+0000')}\r\n`;
                }
                const raw = Buffer.concat([Buffer.from(prefix, 'latin1'), body]);

                // Un seul corps pour tous les destinataires, et pour la copie rangée dans Envoyés. La
                // copie est un confort : une boîte pleine s'en passe, elle n'empêche pas l'envoi.
                const room = mailbox.used_bytes + raw.length <= mailbox.quota_bytes;
                const sent = user.saveSent && room ? await deps.repo.findFolder(mailbox.id, 'Sent') : null;
                const blob = await deps.store.writeBlob(mailbox, raw);
                const references = recipients.length + (sent ? 1 : 0);
                if (references > 1) await deps.repo.refBlob(blob.id, references - 1);

                const cipher = deps.cipherFor(mailbox.workspace_id);
                for (const rcpt of recipients) {
                    await deps.repo.enqueue({
                        workspaceId: mailbox.workspace_id,
                        mailboxId: mailbox.id,
                        blobId: blob.id,
                        content: await seal(cipher, { from: mailbox.address, rcpt, lastError: '' }),
                        now: now()
                    });
                }
                hourly.add(mailbox.id, nowMs, recipients.length);

                if (sent) {
                    await deps.store.appendBlob(mailbox, sent, blob, await deps.store.sealMeta(mailbox, raw), {
                        flags: FLAG.Seen,
                        internalDate: now(),
                        size: raw.length
                    });
                }
                deps.kick();
            })().then(
                () => done(),
                (error: unknown) => {
                    const known = typeof (error as { responseCode?: number }).responseCode === 'number';
                    if (!known) deps.logger.error({ err: (error as Error).message }, 'Soumission interrompue');
                    done(known ? (error as Error) : smtpError(451, '4.3.0 Temporary failure, try again later'));
                }
            );
        }
    });
    server.on('error', (error) => deps.logger.warn({ err: error.message }, 'Soumission SMTP'));
    const unfollow = followCertificate(server, deps.certificates);

    return {
        listen: (port) => listen(server, port),
        async stop() {
            unfollow();
            await close(server);
        }
    };
}
