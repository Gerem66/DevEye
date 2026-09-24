import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';

import { isPublicIp, type SdkCipher, type SdkLogger, type SdkServerKeys } from '@deveye/types/sdk/server';
import nodemailer from 'nodemailer';

import { now, queueContentSchema, seal, unseal } from '../_shared';
import { ensureDomainKey, openPrivateKey } from '../dkim';
import { NO_VERDICTS, type Delivery } from '../engine/delivery';
import type { EventRecorder } from '../engine/events';
import { OverQuotaError, type MailStore } from '../engine/mailstore';
import type { MailboxRow, MailserverRepo, QueueRow } from '../repo';
import { buildBounce } from './dsn';

/**
 * La file d'envoi : une ligne par destinataire, remise au serveur que son
 * domaine désigne. Un refus définitif (5xx) rend un avis de non-remise à
 * l'expéditeur ; tout le reste se réessaie, de plus en plus rarement.
 */

/** Minutes avant l'essai suivant. Épuisée (environ quatre jours), la ligne est rendue à l'expéditeur. */
const RETRY_MINUTES = [5, 15, 30, 60, 120, 240, 480, 960, 1_440, 1_440, 1_440];
const BATCH = 25;
const CONCURRENCY = 4;
const TICK_MS = 15_000;

export interface OutboundSeam {
    /** Les serveurs d'un domaine, du plus prioritaire au moins. `[]` : pas de MX. */
    resolveMx?(domain: string): Promise<{ exchange: string; priority: number }[]>;
    /** Les adresses d'un nom d'hôte. */
    resolveHost?(host: string): Promise<string[]>;
    port?: number;
}

export interface OutboundDeps {
    hostname: string;
    repo: MailserverRepo;
    store: MailStore;
    delivery: Delivery;
    events: EventRecorder;
    keys: SdkServerKeys;
    cipherFor(workspaceId: number): SdkCipher;
    ipv4Only: boolean;
    allowPrivate: boolean;
    logger: SdkLogger;
}

export interface Outbound {
    start(): void;
    /** Arrête le cadran et interrompt le tour en cours entre deux lots ; rend la fin de ce tour. */
    stop(): Promise<void>;
    kick(): void;
    /** Un tour complet, attendu : pour les tests. */
    runOnce(): Promise<void>;
}

class PermanentFailure extends Error {}

const orEmpty = async <T>(lookup: Promise<T[]>): Promise<T[]> => {
    try {
        return await lookup;
    } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === 'ENOTFOUND' || code === 'ENODATA') return [];
        throw error;
    }
};

export function createOutbound(deps: OutboundDeps, seam: OutboundSeam = {}): Outbound {
    const resolver = new Resolver({ timeout: 8_000, tries: 2 });
    const resolveMx = seam.resolveMx ?? ((domain: string) => orEmpty(resolver.resolveMx(domain)));
    const resolveHost =
        seam.resolveHost ??
        (async (host: string) => [
            ...(await orEmpty(resolver.resolve4(host))),
            ...(deps.ipv4Only ? [] : await orEmpty(resolver.resolve6(host)))
        ]);

    let timer: ReturnType<typeof setInterval> | null = null;
    let running: Promise<void> | null = null;
    let again = false;
    let halted = false;

    /** Où remettre : les adresses des MX, dans l'ordre de priorité. Sans MX, le domaine lui-même (RFC 5321 §5.1). */
    async function targetsOf(domain: string): Promise<{ host: string; ip: string }[]> {
        const records = (await resolveMx(domain)).sort((a, b) => a.priority - b.priority);
        // Un MX « . » dit que le domaine ne reçoit aucun courrier (RFC 7505).
        if (records.some((mx) => mx.exchange === '' || mx.exchange === '.')) {
            throw new PermanentFailure('5.1.10 Le domaine du destinataire n’accepte pas de courrier');
        }
        const hosts = records.length > 0 ? records.map((mx) => mx.exchange.replace(/\.$/, '')) : [domain];
        const targets: { host: string; ip: string }[] = [];
        for (const host of hosts.slice(0, 5)) {
            const ips = isIP(host) !== 0 ? [host] : await resolveHost(host);
            for (const ip of ips) {
                // Un MX qui vise une adresse privée ferait sonder le réseau du serveur par n'importe quel expéditeur.
                if (deps.allowPrivate || isPublicIp(ip)) targets.push({ host, ip });
            }
        }
        if (targets.length === 0) throw new PermanentFailure('5.1.2 Aucun serveur de courrier pour ce domaine');
        return targets;
    }

    async function transmit(mailbox: MailboxRow, from: string, rcpt: string, raw: Buffer): Promise<string> {
        const domain = rcpt.slice(rcpt.lastIndexOf('@') + 1);
        const senderHost = from.slice(from.lastIndexOf('@') + 1);
        const key = await ensureDomainKey(deps.repo, deps.keys, {
            workspaceId: mailbox.workspace_id,
            host: senderHost
        });
        const privateKey = openPrivateKey(deps.keys, key);

        let lastError: Error = new Error('4.4.1 Aucun serveur joignable');
        for (const target of await targetsOf(domain)) {
            const transport = nodemailer.createTransport({
                host: target.ip,
                port: seam.port ?? 25,
                name: deps.hostname,
                secure: false,
                opportunisticTLS: true,
                // Le chiffrement est opportuniste : un certificat auto-signé vaut mieux que du clair.
                tls: { servername: target.host, rejectUnauthorized: false },
                connectionTimeout: 30_000,
                greetingTimeout: 30_000,
                socketTimeout: 120_000,
                dkim: privateKey ? { domainName: senderHost, keySelector: key.selector, privateKey } : undefined
            });
            try {
                const info = await transport.sendMail({ envelope: { from, to: [rcpt] }, raw });
                return `${target.host} : ${String(info.response ?? '').slice(0, 200)}`;
            } catch (error) {
                const code = (error as { responseCode?: number }).responseCode;
                if (typeof code === 'number' && code >= 500) {
                    throw new PermanentFailure(`${target.host} : ${(error as Error).message}`);
                }
                lastError = error as Error;
            } finally {
                transport.close();
            }
        }
        throw lastError;
    }

    async function bounce(mailbox: MailboxRow, rcpt: string, raw: Buffer, diagnostic: string): Promise<void> {
        const headerEnd = raw.indexOf('\r\n\r\n');
        const notice = buildBounce({
            hostname: deps.hostname,
            sender: mailbox.address,
            recipient: rcpt,
            diagnostic,
            originalHeaders: raw
                .subarray(0, headerEnd === -1 ? Math.min(raw.length, 8_192) : headerEnd)
                .toString('latin1')
        });
        await deps.events.record(mailbox, { kind: 'bounced', size: raw.length, peer: rcpt, detail: diagnostic });
        try {
            await deps.delivery.deliver(mailbox, notice, {
                from: `MAILER-DAEMON@${deps.hostname}`,
                verdicts: NO_VERDICTS,
                junk: false
            });
        } catch (error) {
            if (!(error instanceof OverQuotaError)) throw error;
        }
    }

    async function attempt(row: QueueRow): Promise<void> {
        if (!(await deps.repo.claimQueue(row.id))) return;
        const mailbox = await deps.repo.findById(row.mailbox_id);
        const finish = async (): Promise<void> => {
            await deps.repo.removeQueue(row.id);
            await deps.store.releaseBlob(row.blob_id);
        };
        if (!mailbox) return finish();

        const cipher = deps.cipherFor(row.workspace_id);
        const content = await unseal(cipher, row.content, queueContentSchema, { from: '', rcpt: '', lastError: '' });
        if (content.rcpt === '') return finish();
        const raw = await deps.store.readBlob(mailbox, row.blob_id);

        try {
            const local = await deps.delivery.resolve(content.rcpt);
            let detail: string;
            if (local) {
                await deps.delivery.deliver(local, raw, { from: content.from, verdicts: NO_VERDICTS, junk: false });
                detail = 'Remis sur ce serveur';
            } else {
                detail = await transmit(mailbox, content.from, content.rcpt, raw);
            }
            await deps.events.record(mailbox, { kind: 'sent', size: raw.length, peer: content.rcpt, detail });
            await finish();
        } catch (error) {
            const message = (error as Error).message;
            const attempts = row.attempts + 1;
            const permanent =
                error instanceof PermanentFailure || error instanceof OverQuotaError || attempts > RETRY_MINUTES.length;
            if (permanent) {
                await bounce(
                    mailbox,
                    content.rcpt,
                    raw,
                    error instanceof OverQuotaError ? '5.2.2 Boîte pleine' : message
                );
                return finish();
            }
            await deps.events.record(mailbox, {
                kind: 'deferred',
                size: raw.length,
                peer: content.rcpt,
                detail: message
            });
            await deps.repo.deferQueue(
                row.id,
                attempts,
                now() + RETRY_MINUTES[attempts - 1] * 60,
                await seal(cipher, { ...content, lastError: message.slice(0, 300) })
            );
        }
    }

    async function pass(): Promise<void> {
        const due = await deps.repo.dueQueue(now(), BATCH);
        for (let i = 0; i < due.length && !halted; i += CONCURRENCY) {
            await Promise.all(
                due.slice(i, i + CONCURRENCY).map((row) =>
                    attempt(row).catch((error: unknown) => {
                        deps.logger.error(
                            { err: (error as Error).message, queueId: row.id },
                            'File d’envoi : essai interrompu'
                        );
                    })
                )
            );
        }
    }

    /** Un seul tour à la fois ; un coup de pouce reçu pendant un tour en redemande un autre. */
    function run(): Promise<void> {
        if (running) {
            again = true;
            return running;
        }
        halted = false;
        running = (async () => {
            try {
                do {
                    again = false;
                    await pass();
                } while (again && !halted);
            } catch (error) {
                deps.logger.error({ err: (error as Error).message }, 'File d’envoi : tour interrompu');
            } finally {
                running = null;
            }
        })();
        return running;
    }

    return {
        start() {
            if (timer) return;
            timer = setInterval(() => void run(), TICK_MS);
            timer.unref();
            void run();
        },
        stop() {
            if (timer) clearInterval(timer);
            timer = null;
            halted = true;
            return running ?? Promise.resolve();
        },
        kick: () => void run(),
        runOnce: run
    };
}
