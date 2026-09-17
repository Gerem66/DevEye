import type { SdkLogger } from '@deveye/types/sdk/server';
import { SMTPServer } from 'smtp-server';

import type { Delivery } from '../engine/delivery';
import type { EventRecorder } from '../engine/events';
import { IpLimiter } from '../engine/limits';
import { OverQuotaError } from '../engine/mailstore';
import type { TlsStore } from '../engine/tls';
import type { MailboxRow } from '../repo';
import { close, collect, followCertificate, listen, receivedHeader, smtpError, tlsOptions } from './shared';
import { dispositionOf, type InboundVerifier } from './verify';

/**
 * Le port 25 : le courrier qui arrive du reste du monde. Jamais un relais : un
 * destinataire qui n'est pas une boîte d'ici est refusé dès `RCPT TO`, avant
 * que le moindre octet du message ne soit lu, et personne ne s'y authentifie.
 */

const MAX_RECIPIENTS = 50;
/** Un message qui a fait cinquante sauts tourne en rond. */
const MAX_RECEIVED = 50;

export interface InboundDeps {
    hostname: string;
    maxBytes: number;
    certificates: TlsStore;
    delivery: Delivery;
    events: EventRecorder;
    verify: InboundVerifier;
    logger: SdkLogger;
}

export interface SmtpListener {
    listen(port: number): Promise<number>;
    stop(): Promise<void>;
}

export function createInboundServer(deps: InboundDeps): SmtpListener {
    const limiter = new IpLimiter(10, 60);
    /** Les boîtes acceptées à `RCPT TO`, par session : `onData` n'a pas à les résoudre deux fois. */
    const accepted = new Map<string, Map<string, MailboxRow>>();
    const hasCertificate = deps.certificates.current() !== null;

    const server = new SMTPServer({
        name: deps.hostname,
        banner: 'DevEye',
        size: deps.maxBytes,
        ...tlsOptions(deps.certificates),
        // Sans certificat, STARTTLS échouerait à la poignée de main : mieux vaut ne pas le proposer.
        disabledCommands: hasCertificate ? ['AUTH'] : ['AUTH', 'STARTTLS'],
        authOptional: true,
        disableReverseLookup: true,
        maxClients: 200,
        socketTimeout: 60_000,
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
            accepted.delete(session.id);
        },

        onRcptTo(address, session, done) {
            const held = accepted.get(session.id) ?? new Map<string, MailboxRow>();
            if (held.size >= MAX_RECIPIENTS) return done(smtpError(452, 'Too many recipients'));
            deps.delivery
                .resolve(address.address)
                .then((mailbox) => {
                    if (!mailbox) return done(smtpError(550, '5.1.1 No such mailbox here'));
                    held.set(address.address.toLowerCase(), mailbox);
                    accepted.set(session.id, held);
                    done();
                })
                .catch((error: unknown) => {
                    deps.logger.error({ err: (error as Error).message }, 'SMTP : destinataire non résolu');
                    done(smtpError(451, '4.3.0 Temporary failure, try again later'));
                });
        },

        onData(stream, session, done) {
            const recipients = accepted.get(session.id) ?? new Map<string, MailboxRow>();
            accepted.delete(session.id);
            void (async () => {
                const body = await collect(stream, deps.maxBytes);
                if (body === null) throw smtpError(552, '5.3.4 Message too large');
                if (recipients.size === 0) throw smtpError(554, '5.5.1 No valid recipients');

                const sender = session.envelope.mailFrom ? session.envelope.mailFrom.address : '';
                const headerEnd = body.indexOf('\r\n\r\n');
                const headerBlock = body.subarray(0, headerEnd === -1 ? body.length : headerEnd).toString('latin1');
                if ((headerBlock.match(/^Received:/gim) ?? []).length > MAX_RECEIVED) {
                    throw smtpError(554, '5.4.6 Too many hops');
                }

                const check = await deps.verify(body, {
                    ip: session.remoteAddress,
                    helo: session.hostNameAppearsAs,
                    sender
                });
                const disposition = dispositionOf(check);
                if (disposition === 'reject') {
                    for (const mailbox of recipients.values()) {
                        await deps.events.record(mailbox, {
                            kind: 'rejected',
                            size: body.length,
                            ...check.verdicts,
                            peer: sender,
                            detail: 'DMARC : le domaine de l’expéditeur demande le refus'
                        });
                    }
                    throw smtpError(550, '5.7.1 Message rejected by the sender domain DMARC policy');
                }

                let delivered = 0;
                let full = 0;
                for (const [recipient, mailbox] of recipients) {
                    const prefix =
                        `Return-Path: <${sender}>\r\nDelivered-To: ${recipient}\r\n` +
                        receivedHeader({
                            helo: session.hostNameAppearsAs,
                            ip: session.remoteAddress,
                            hostname: deps.hostname,
                            protocol: session.secure ? 'ESMTPS' : 'ESMTP',
                            id: session.id,
                            recipient
                        }) +
                        check.headers;
                    try {
                        await deps.delivery.deliver(mailbox, Buffer.concat([Buffer.from(prefix, 'latin1'), body]), {
                            from: sender,
                            verdicts: check.verdicts,
                            junk: disposition === 'junk'
                        });
                        delivered += 1;
                    } catch (error) {
                        if (!(error instanceof OverQuotaError)) throw error;
                        full += 1;
                        await deps.events.record(mailbox, {
                            kind: 'rejected',
                            size: body.length,
                            ...check.verdicts,
                            peer: sender,
                            detail: 'Boîte pleine'
                        });
                    }
                }
                // Le `250` ne part qu'ici, une fois les lignes écrites : un arrêt avant lui laisse l'expéditeur réessayer.
                if (delivered === 0 && full > 0) throw smtpError(552, '5.2.2 Mailbox full');
            })().then(
                () => done(),
                (error: unknown) => {
                    const known = typeof (error as { responseCode?: number }).responseCode === 'number';
                    if (!known) deps.logger.error({ err: (error as Error).message }, 'SMTP : remise interrompue');
                    done(known ? (error as Error) : smtpError(451, '4.3.0 Temporary failure, try again later'));
                }
            );
        }
    });
    server.on('error', (error) => deps.logger.warn({ err: error.message }, 'SMTP entrant'));
    const unfollow = followCertificate(server, deps.certificates);

    return {
        listen: (port) => listen(server, port),
        async stop() {
            unfollow();
            await close(server);
        }
    };
}
