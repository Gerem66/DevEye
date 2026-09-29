import fs from 'node:fs/promises';

import type { FeatureServiceDeps, SdkPublicApp, SdkServiceHealth } from '@deveye/types/sdk/server';

import type { ListenerState } from '../../contracts/domain';
import { type EngineHandle, now } from '../_shared';
import { env, maxMessageBytes } from '../env';
import { createImapServer, type ImapServer } from '../imap/server';
import type { MailserverRepo } from '../repo';
import { createInboundServer, type SmtpListener } from '../smtp/inbound';
import { createOutbound } from '../smtp/outbound';
import { createSubmissionServer } from '../smtp/submission';
import { createInboundVerifier } from '../smtp/verify';
import { createAcme } from './acme';
import { createAuthenticator } from './auth';
import { diskBlobStore } from './blobs';
import { createDelivery } from './delivery';
import { createEventRecorder } from './events';
import { listenersHealth } from './health';
import { createMailStore } from './mailstore';
import { Notifier } from './notifier';
import { TlsStore } from './tls';

/**
 * Le moteur : il assemble le stockage, l'authentification, la remise, et ouvre
 * les ports. Sans `MAILSERVER_HOSTNAME` rien n'écoute, mais le reste vit : une
 * boîte se crée et se supprime quand même.
 */

/** L'arrêt de l'app attend les services avant de rendre son port HTTP : celui-ci ne doit jamais le retenir. */
const STOP_DEADLINE_MS = 1_200;
const ACME_TICK_MS = 12 * 3_600_000;
const FILE_TICK_MS = 60_000;
const SWEEP_TICK_MS = 24 * 3_600_000;

type ListenerName = ListenerState['name'];

export interface Engine {
    start(): Promise<void>;
    stop(): Promise<void>;
    health(): SdkServiceHealth;
    handle: EngineHandle;
    publicRoutes(app: SdkPublicApp): void;
}

export function createEngine(deps: FeatureServiceDeps<MailserverRepo>): Engine {
    const hostname = env.MAILSERVER_HOSTNAME;
    const configured = hostname !== '';
    const { repo } = deps;

    const notifier = new Notifier();
    const blobs = diskBlobStore(env.MAILSERVER_STORAGE_DIR);
    const store = createMailStore({ repo, blobs, keys: deps.keys, cipherFor: deps.cipherFor, notifier });
    const events = createEventRecorder({
        repo,
        cipherFor: deps.cipherFor,
        beat: (workspaceId) => deps.live.changed(workspaceId, ['mailserverFlow'])
    });
    const auth = createAuthenticator({ repo, events, pauses: deps.pauses });
    const delivery = createDelivery({ repo, domains: deps.domains, pauses: deps.pauses, store, events });
    const certificates = new TlsStore();
    const usesFiles = env.MAILSERVER_TLS_CERT_FILE !== '' && env.MAILSERVER_TLS_KEY_FILE !== '';
    const acme = createAcme({
        hostname,
        email: env.MAILSERVER_ACME_EMAIL,
        directory: env.MAILSERVER_ACME_DIRECTORY,
        repo,
        keys: deps.keys,
        certificates,
        logger: deps.logger
    });
    const outbound = createOutbound({
        hostname,
        repo,
        store,
        delivery,
        events,
        keys: deps.keys,
        cipherFor: deps.cipherFor,
        ipv4Only: env.MAILSERVER_OUTBOUND_IPV4_ONLY,
        allowPrivate: env.MAILSERVER_ALLOW_PRIVATE_MX,
        logger: deps.logger
    });

    const NEEDS_CERTIFICATE = 'En attente d’un certificat';
    const states: Record<ListenerName, ListenerState> = {
        smtp: { name: 'smtp', port: 25, up: false, reason: '' },
        submissions: { name: 'submissions', port: env.MAILSERVER_PUBLIC_PORT_SUBMISSIONS, up: false, reason: '' },
        submission: { name: 'submission', port: env.MAILSERVER_PUBLIC_PORT_SUBMISSION, up: false, reason: '' },
        imaps: { name: 'imaps', port: env.MAILSERVER_PUBLIC_PORT_IMAPS, up: false, reason: '' }
    };
    const smtpListeners = new Map<ListenerName, SmtpListener>();
    let imap: ImapServer | null = null;
    let fileStamp = '';
    const timers: ReturnType<typeof setInterval>[] = [];
    let unsubscribe: (() => void) | null = null;
    let stopped = false;
    /** Le tour d'envoi qu'un arrêt a laissé finir : un redémarrage l'attend avant de reprendre la file. */
    let draining: Promise<void> = Promise.resolve();
    /** Un message reçu pendant l'arrêt reste en file jusqu'au redémarrage. */
    const kick = (): void => {
        if (!stopped) outbound.kick();
    };

    /** Un port qui ne s'ouvre pas (déjà pris, interdit) se dit dans l'état du serveur, et ne fait pas tomber l'app. */
    async function open(name: ListenerName, port: number, listen: () => Promise<unknown>): Promise<boolean> {
        try {
            await listen();
            states[name] = { ...states[name], up: true, reason: '' };
            return true;
        } catch (error) {
            states[name] = { ...states[name], up: false, reason: (error as Error).message.slice(0, 200) };
            deps.logger.error(
                { listener: name, port, err: (error as Error).message },
                'Serveur mail : port non ouvert'
            );
            return false;
        }
    }

    async function openInbound(): Promise<void> {
        const held = smtpListeners.get('smtp');
        if (held) await held.stop();
        const server = createInboundServer({
            hostname,
            maxBytes: maxMessageBytes(),
            certificates,
            delivery,
            events,
            verify: createInboundVerifier(hostname),
            logger: deps.logger
        });
        smtpListeners.set('smtp', server);
        await open('smtp', env.MAILSERVER_PORT_SMTP, () => server.listen(env.MAILSERVER_PORT_SMTP));
    }

    /** Les trois ports qui n'existent pas sans certificat : ils ne s'ouvrent qu'une fois par démarrage, quand il arrive. */
    let securing: Promise<void> | null = null;
    function openSecured(): Promise<void> {
        if (certificates.current() === null) return Promise.resolve();
        // Un renouvellement, ou le certificat qui arrive pendant le démarrage, ne rouvre rien.
        securing ??= openSecuredOnce();
        return securing;
    }

    async function openSecuredOnce(): Promise<void> {
        const submissionDeps = {
            hostname,
            maxBytes: maxMessageBytes(),
            certificates,
            repo,
            pauses: deps.pauses,
            store,
            auth,
            cipherFor: deps.cipherFor,
            kick,
            logger: deps.logger
        };
        for (const [name, port, implicit] of [
            ['submissions', env.MAILSERVER_PORT_SUBMISSIONS, true],
            ['submission', env.MAILSERVER_PORT_SUBMISSION, false]
        ] as const) {
            const server = createSubmissionServer(submissionDeps, implicit);
            smtpListeners.set(name, server);
            await open(name, port, () => server.listen(port));
        }
        const imapServer = createImapServer(
            { repo, store, auth, notifier, hostname, maxMessageBytes: maxMessageBytes(), logger: deps.logger },
            certificates
        );
        imap = imapServer;
        await open('imaps', env.MAILSERVER_PORT_IMAPS, () => imapServer.listen(env.MAILSERVER_PORT_IMAPS));
        // Le port 25 tournait sans STARTTLS : il se rouvre pour le proposer.
        await openInbound();
    }

    /** La paire PEM de l'opérateur, relue quand ses fichiers changent. */
    async function loadFiles(): Promise<void> {
        try {
            const [certStat, keyStat] = await Promise.all([
                fs.stat(env.MAILSERVER_TLS_CERT_FILE),
                fs.stat(env.MAILSERVER_TLS_KEY_FILE)
            ]);
            const stamp = `${certStat.mtimeMs}|${keyStat.mtimeMs}`;
            if (stamp === fileStamp) return;
            const [cert, key] = await Promise.all([
                fs.readFile(env.MAILSERVER_TLS_CERT_FILE, 'utf8'),
                fs.readFile(env.MAILSERVER_TLS_KEY_FILE, 'utf8')
            ]);
            certificates.set({ cert, key }, 'file');
            fileStamp = stamp;
        } catch (error) {
            certificates.lastError = (error as Error).message.slice(0, 300);
            deps.logger.warn({ err: certificates.lastError }, 'Serveur mail : certificat illisible');
        }
    }

    const every = (ms: number, task: () => Promise<void>): void => {
        const timer = setInterval(() => {
            task().catch((error: unknown) =>
                deps.logger.error({ err: (error as Error).message }, 'Serveur mail : tâche de fond')
            );
        }, ms);
        timer.unref();
        timers.push(timer);
    };

    const handle: EngineHandle = {
        async status() {
            const info = certificates.info();
            return {
                configured,
                hostname,
                listeners: configured ? Object.values(states) : [],
                certificate: info ? { source: info.source, notAfter: info.notAfter, staging: info.staging } : null,
                certificateError: certificates.lastError,
                queueDepth: await repo.queueDepth()
            };
        },
        connection: () =>
            configured
                ? {
                      host: hostname,
                      imapPort: env.MAILSERVER_PUBLIC_PORT_IMAPS,
                      smtpPort: env.MAILSERVER_PUBLIC_PORT_SUBMISSIONS,
                      submissionPort: env.MAILSERVER_PUBLIC_PORT_SUBMISSION
                  }
                : null,
        async dropMailbox(mailboxId, purge) {
            notifier.dropMailbox(mailboxId);
            if (purge) await store.purgeMailbox(mailboxId);
        },
        kickQueue: kick,
        releaseBlob: (blobId) => store.releaseBlob(blobId)
    };

    return {
        handle,

        async start() {
            await draining;
            stopped = false;
            // Un arrêt en pleine remise laisse des lignes « en cours » que personne ne reprendrait.
            await repo.requeueStuck();
            if (!configured) return;

            for (const name of ['submissions', 'submission', 'imaps'] as const) {
                states[name] = { ...states[name], reason: NEEDS_CERTIFICATE };
            }
            unsubscribe = certificates.subscribe(() => void openSecured());

            if (usesFiles) {
                await loadFiles();
                every(FILE_TICK_MS, loadFiles);
            } else {
                // Sans attendre : le démarrage de l'app ne dépend pas de la disponibilité de Let's Encrypt.
                void acme.ensure();
                every(ACME_TICK_MS, () => acme.ensure());
            }
            if (certificates.current() === null) await openInbound();
            else await openSecured();

            outbound.start();
            every(SWEEP_TICK_MS, async () => {
                await repo.purgeEvents(now() - env.MAILSERVER_EVENTS_RETENTION_DAYS * 86_400);
            });
        },

        async stop() {
            stopped = true;
            for (const timer of timers.splice(0)) clearInterval(timer);
            unsubscribe?.();
            unsubscribe = null;
            draining = outbound.stop();
            events.stop();
            const opening = securing;
            securing = null;
            const closing = (async () => {
                // Des ports en cours d'ouverture se referment avec les autres.
                await opening?.catch(() => undefined);
                const held = [...smtpListeners.values(), ...(imap ? [imap] : [])];
                smtpListeners.clear();
                imap = null;
                for (const name of Object.keys(states) as ListenerName[]) {
                    states[name] = { ...states[name], up: false, reason: '' };
                }
                await Promise.allSettled(held.map((server) => server.stop()));
            })();
            await Promise.race([
                Promise.all([closing, draining]),
                new Promise((resolve) => setTimeout(resolve, STOP_DEADLINE_MS).unref())
            ]);
        },

        health: () => listenersHealth(configured ? Object.values(states) : []),

        publicRoutes(app) {
            if (!configured || usesFiles) return;
            app.get(
                '/.well-known/acme-challenge/:token',
                { exposure: 'everywhere', rateLimit: { max: 60, timeWindow: '1 minute' } },
                (req, reply) => {
                    const token = String((req.params as { token?: unknown } | undefined)?.token ?? '');
                    const answer = acme.challenge(token);
                    if (answer === null) return Promise.resolve(reply.code(404).send());
                    return Promise.resolve(reply.header('content-type', 'text/plain').send(answer));
                }
            );
        }
    };
}
