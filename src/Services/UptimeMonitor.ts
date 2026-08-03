import type { UptimeServiceRow, UptimeStatus } from 'deveye-types';
import type { Logger } from 'pino';

import { decryptError, decryptService, encryptError, type ServicePayload } from '@/features/uptime/_shared';
import { decryptCredentials } from '@/features/mail/_shared';
import * as mailClient from '@/Services/MailAccountClient';
import { createOpenCipher, type Cipher } from '@/Services/SecureStore';
import { env } from '@/Utils/Env';

import type { Database } from '@/db';
import type Encryption from './Encryption';
import type { AuditLog } from './AuditLog';

/**
 * Uptime scheduler (process singleton).
 *
 * Every tick it claims the services whose next probe is due, runs them with a
 * bounded concurrency, and writes back three things at once: the raw ping, its
 * daily rollup, and the service's live state. Outages are materialised as
 * incidents — opened when a service crosses its `failure_threshold`, closed on
 * the first success — which is also what makes notifications exactly-once: an
 * alert belongs to an incident, not to a probe.
 *
 * It runs with **no session and no password**, so every encrypted field it
 * touches (target, error messages, notification channels) goes through the
 * user's *open* cipher — see `Docs/SECURITY_MODEL.md`.
 */

interface MonitorDeps {
    db: Database;
    crypt: Encryption;
    audit: AuditLog;
    logger: Logger;
}

/** Outcome of a single HTTP probe. */
interface ProbeOutcome {
    up: boolean;
    httpStatus: number | null;
    responseMs: number | null;
    /** Plaintext failure reason, or null on success. */
    error: string | null;
}

/** How long a probe body is read before giving up on the keyword match. */
const KEYWORD_BODY_MAX_BYTES = 512 * 1024;

/** Run one HTTP probe. Never throws: a failure *is* the result. */
async function probeService(target: ServicePayload, row: UptimeServiceRow): Promise<ProbeOutcome> {
    const started = Date.now();
    try {
        const response = await fetch(target.url, {
            method: row.method,
            signal: AbortSignal.timeout(row.timeout_seconds * 1000),
            redirect: 'follow',
            headers: { 'user-agent': 'DevEye-Uptime/1.0' }
        });
        const httpStatus = response.status;

        // The body is only read when a keyword is expected — otherwise the probe
        // stays as cheap as possible and the connection is released right away.
        let body: string | null = null;
        if (target.keyword && row.method !== 'HEAD') {
            body = (await response.text()).slice(0, KEYWORD_BODY_MAX_BYTES);
        } else {
            // A body already drained by fetch rejects here; that is not a probe failure.
            await response.body?.cancel().catch(() => undefined);
        }
        const responseMs = Date.now() - started;

        const statusOk =
            row.expected_status === null ? httpStatus >= 200 && httpStatus < 400 : httpStatus === row.expected_status;
        if (!statusOk) {
            const expected = row.expected_status === null ? '2xx/3xx' : String(row.expected_status);
            return { up: false, httpStatus, responseMs, error: `Statut HTTP ${httpStatus} (attendu ${expected})` };
        }
        if (target.keyword && !(body ?? '').includes(target.keyword)) {
            return { up: false, httpStatus, responseMs, error: `Mot-clé « ${target.keyword} » absent de la réponse` };
        }
        return { up: true, httpStatus, responseMs, error: null };
    } catch (e) {
        const responseMs = Date.now() - started;
        const name = e instanceof Error ? e.name : '';
        // AbortSignal.timeout rejects with a TimeoutError; everything else is a
        // connection-level failure (DNS, refused, TLS…), whose `cause` carries
        // the useful detail Node hides behind a generic "fetch failed".
        if (name === 'TimeoutError') {
            return {
                up: false,
                httpStatus: null,
                responseMs,
                error: `Délai dépassé (${row.timeout_seconds} s)`
            };
        }
        const cause = e instanceof Error && e.cause instanceof Error ? e.cause.message : null;
        const message = e instanceof Error ? e.message : String(e);
        return { up: false, httpStatus: null, responseMs: null, error: cause ?? message };
    }
}

/**
 * Discord truncates hard at 2000 characters and rejects anything longer; an
 * error string from an odd endpoint can be arbitrarily long.
 */
const WEBHOOK_TEXT_MAX = 1900;

/** Payload accepted by Discord, Slack and a homegrown endpoint alike. */
interface WebhookAlert {
    event: 'down' | 'recovered' | 'test';
    /** Null on a test alert, which is about no service in particular. */
    service: string | null;
    url: string | null;
    at: number;
    body: string;
}

/**
 * Build that one body.
 *
 * Discord refuses a payload carrying none of `content` / `embeds` / `file`
 * ("Cannot send an empty message", HTTP 400) and Slack reads `text`; both
 * ignore the keys they don't know. Carrying the message under both names — plus
 * the structured fields a custom endpoint wants — covers every target without
 * asking the user which service they pasted the URL from.
 */
function webhookPayload(alert: WebhookAlert): Record<string, unknown> {
    const text = alert.body.slice(0, WEBHOOK_TEXT_MAX);
    return {
        content: text,
        text,
        event: alert.event,
        service: alert.service,
        url: alert.url,
        at: alert.at
    };
}

/** A rejected webhook, explained: the provider's own words beat "HTTP 400". */
async function webhookRejection(response: Response): Promise<string> {
    const detail = await response
        .text()
        .then((body) => body.slice(0, 200).trim())
        .catch(() => '');
    return detail ? `Le webhook a répondu ${response.status} : ${detail}` : `Le webhook a répondu ${response.status}`;
}

/** Short French date+time used in alert bodies. */
function formatMoment(epochSeconds: number): string {
    return new Date(epochSeconds * 1000).toLocaleString('fr-FR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
}

/** "2 h 5 min" / "45 s" — outage length in an alert. */
function formatDuration(seconds: number): string {
    if (seconds < 60) return `${seconds} s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} h ${minutes % 60} min`;
    return `${Math.floor(hours / 24)} j ${hours % 24} h`;
}

export class UptimeMonitor {
    private timer: ReturnType<typeof setInterval> | null = null;
    /** Guards against a slow tick overlapping the next one. */
    private ticking = false;
    /** Open ciphers, one per user, reused across ticks (each holds its DEK). */
    private readonly ciphers = new Map<number, Cipher>();
    /**
     * Probes currently running, by service id. A second request for the same
     * service joins the running one instead of starting its own: two concurrent
     * probes could each open an incident, and only the newest would ever be
     * closed. `uptime.checkNow` landing on a scheduled tick is that race.
     */
    private readonly inFlight = new Map<number, Promise<void>>();

    constructor(private readonly deps: MonitorDeps) {}

    start(): void {
        if (this.timer) return;
        this.timer = setInterval(() => void this.tick(), env.UPTIME_TICK_SECONDS * 1000);
        this.timer.unref();
        void this.tick();
        this.deps.logger.info({ tickSeconds: env.UPTIME_TICK_SECONDS }, 'Uptime monitor started');
    }

    stop(): void {
        if (!this.timer) return;
        clearInterval(this.timer);
        this.timer = null;
    }

    private cipherFor(userId: number): Cipher {
        let cipher = this.ciphers.get(userId);
        if (!cipher) {
            cipher = createOpenCipher(this.deps.db, this.deps.crypt, userId);
            this.ciphers.set(userId, cipher);
        }
        return cipher;
    }

    /** Claim every due service and probe them, `UPTIME_CONCURRENCY` at a time. */
    private async tick(): Promise<void> {
        if (this.ticking) return;
        this.ticking = true;
        try {
            const now = Math.floor(Date.now() / 1000);
            const due = await this.deps.db.uptimeServices.listDue(now, env.UPTIME_CONCURRENCY * 4);
            for (let i = 0; i < due.length; i += env.UPTIME_CONCURRENCY) {
                await Promise.all(due.slice(i, i + env.UPTIME_CONCURRENCY).map((row) => this.runOne(row)));
            }
        } catch (e) {
            this.deps.logger.error({ err: e instanceof Error ? e.message : String(e) }, 'Uptime tick failed');
        } finally {
            this.ticking = false;
        }
    }

    /**
     * Probe one service and persist everything that follows from it. Isolated
     * per service so one broken row can never stall the whole tick, and
     * de-duplicated so a service is never probed twice at once.
     */
    async runOne(row: UptimeServiceRow): Promise<void> {
        const running = this.inFlight.get(row.id);
        if (running) return running;
        const probe = this.probeAndRecord(row).finally(() => this.inFlight.delete(row.id));
        this.inFlight.set(row.id, probe);
        return probe;
    }

    private async probeAndRecord(row: UptimeServiceRow): Promise<void> {
        try {
            const cipher = this.cipherFor(row.user_id);
            const target = await decryptService(cipher, row.content);
            const outcome = target.url
                ? await probeService(target, row)
                : { up: false, httpStatus: null, responseMs: null, error: 'Cible illisible (blob corrompu)' };
            await this.record(row, target, outcome, cipher);
        } catch (e) {
            this.deps.logger.error(
                { serviceId: row.id, err: e instanceof Error ? e.message : String(e) },
                'Uptime probe failed'
            );
        }
    }

    /** Persist a probe: raw ping, rollup, live state, incident, notification. */
    private async record(
        row: UptimeServiceRow,
        target: ServicePayload,
        outcome: ProbeOutcome,
        cipher: Cipher
    ): Promise<void> {
        const { db } = this.deps;
        const at = Math.floor(Date.now() / 1000);
        const encryptedError = await encryptError(cipher, outcome.error);

        await db.uptimeHistory.addCheck({
            serviceId: row.id,
            checkedAt: at,
            up: outcome.up,
            httpStatus: outcome.httpStatus,
            responseMs: outcome.responseMs,
            error: encryptedError
        });

        // A single failure is not an outage: the service only flips to `down`
        // once it has failed `failure_threshold` times in a row. Until then it
        // keeps its previous status, so a blip never raises an alert.
        const failures = outcome.up ? 0 : row.consecutive_failures + 1;
        const status: UptimeStatus = outcome.up ? 'up' : failures >= row.failure_threshold ? 'down' : row.status;

        await db.uptimeServices.recordProbe(row.id, {
            status,
            consecutiveFailures: failures,
            checkedAt: at,
            responseMs: outcome.responseMs,
            httpStatus: outcome.httpStatus,
            error: encryptedError
        });

        await this.reconcileIncident(row, target, { ...outcome, at, status, encryptedError }, cipher);
    }

    /**
     * Keep the incident log in step with the probe, and notify on transitions.
     * There is at most one open incident per service, so "went down" and
     * "recovered" each fire exactly once per outage.
     */
    private async reconcileIncident(
        row: UptimeServiceRow,
        target: ServicePayload,
        probe: ProbeOutcome & { at: number; status: UptimeStatus; encryptedError: string | null },
        cipher: Cipher
    ): Promise<void> {
        const { db } = this.deps;
        const open = await db.uptimeHistory.openIncident(row.id);

        if (probe.status === 'down' && !open) {
            const incident = await db.uptimeHistory.openIncidentAt({
                serviceId: row.id,
                startedAt: probe.at,
                httpStatus: probe.httpStatus,
                error: probe.encryptedError
            });
            this.deps.audit.record({
                level: 'error',
                source: 'system',
                category: 'uptime',
                action: 'uptime.down',
                uid: row.user_id,
                ip: '',
                description: `Service « ${target.name} » injoignable`,
                metadata: { serviceId: row.id, httpStatus: probe.httpStatus }
            });
            if (row.notify === 1) {
                const sent = await this.notify(row, target, {
                    subject: `⚠️ ${target.name} est hors ligne`,
                    body: [
                        `Le service « ${target.name} » ne répond plus.`,
                        '',
                        `URL         : ${target.url}`,
                        `Depuis      : ${formatMoment(probe.at)}`,
                        `Erreur      : ${probe.error ?? 'inconnue'}`,
                        probe.httpStatus === null ? null : `Statut HTTP : ${probe.httpStatus}`
                    ]
                        .filter((line) => line !== null)
                        .join('\n'),
                    event: 'down',
                    at: probe.at
                });
                if (sent) await db.uptimeHistory.markIncidentNotified(incident.id);
            }
            return;
        }

        if (probe.up && open) {
            await db.uptimeHistory.closeIncident(open.id, probe.at);
            const duration = Math.max(0, probe.at - open.started_at);
            this.deps.audit.record({
                source: 'system',
                category: 'uptime',
                action: 'uptime.recovered',
                uid: row.user_id,
                ip: '',
                description: `Service « ${target.name} » de nouveau en ligne`,
                metadata: { serviceId: row.id, downtimeSeconds: duration }
            });
            // Only announce a recovery the user was told about, so a silent
            // outage (notifications off at the time) doesn't produce a lone
            // "back online" mail with no context.
            if (row.notify === 1 && open.notified === 1) {
                await this.notify(row, target, {
                    subject: `✅ ${target.name} est de retour`,
                    body: [
                        `Le service « ${target.name} » répond de nouveau.`,
                        '',
                        `URL             : ${target.url}`,
                        `Panne du        : ${formatMoment(open.started_at)}`,
                        `Rétabli le      : ${formatMoment(probe.at)}`,
                        `Durée           : ${formatDuration(duration)}`,
                        `Cause initiale  : ${(await decryptError(cipher, open.error)) ?? 'inconnue'}`
                    ].join('\n'),
                    event: 'recovered',
                    at: probe.at
                });
            }
        }
    }

    /**
     * Deliver one alert on every channel the user enabled. Returns true as soon
     * as one channel accepted it — a failing webhook must not suppress the mail,
     * nor stop the probe loop, so every error is logged and swallowed.
     */
    private async notify(
        row: UptimeServiceRow,
        target: ServicePayload,
        alert: { subject: string; body: string; event: 'down' | 'recovered'; at: number }
    ): Promise<boolean> {
        const channels = await this.resolveChannels(row.user_id);
        let delivered = false;

        if (channels.email && channels.sendAccount) {
            try {
                await mailClient.sendMail(channels.sendAccount.credentials, {
                    from: channels.sendAccount.fromEmail,
                    to: [{ name: null, address: channels.email }],
                    subject: alert.subject,
                    text: alert.body
                });
                delivered = true;
            } catch (e) {
                this.deps.logger.error(
                    { serviceId: row.id, err: e instanceof Error ? e.message : String(e) },
                    'Uptime alert mail failed'
                );
            }
        }

        if (channels.webhook) {
            try {
                const response = await fetch(channels.webhook, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    signal: AbortSignal.timeout(10_000),
                    body: JSON.stringify(
                        webhookPayload({
                            event: alert.event,
                            service: target.name,
                            url: target.url,
                            at: alert.at,
                            body: alert.body
                        })
                    )
                });
                // A rejected POST is not a delivery: counting it would mark the
                // incident notified and later send a lone recovery message.
                if (response.ok) delivered = true;
                else {
                    this.deps.logger.warn(
                        { serviceId: row.id, reason: await webhookRejection(response) },
                        'Uptime alert webhook rejected'
                    );
                }
            } catch (e) {
                this.deps.logger.error(
                    { serviceId: row.id, err: e instanceof Error ? e.message : String(e) },
                    'Uptime alert webhook failed'
                );
            }
        }

        return delivered;
    }

    /**
     * The user's enabled alert channels. The mail recipient defaults to the
     * sending account's own address. `sendAccount` is null whenever no usable
     * "open"-tier account is configured — the caller must skip mail delivery
     * (never a hard failure: the webhook channel is independent).
     */
    async resolveChannels(userId: number): Promise<{
        email: string | null;
        sendAccount: { credentials: mailClient.MailCredentials; fromEmail: string } | null;
        webhook: string | null;
    }> {
        const { db } = this.deps;
        const settings = await db.uptimeSettings.get(userId);
        const emailEnabled = settings ? settings.email_enabled === 1 : true;
        const cipher = this.cipherFor(userId);

        let email: string | null = null;
        let sendAccount: { credentials: mailClient.MailCredentials; fromEmail: string } | null = null;
        if (emailEnabled && settings?.mail_account_id) {
            const account = await db.mailAccounts.findById(settings.mail_account_id, userId);
            if (account && account.enabled === 1 && account.security_tier === 'open') {
                const accountEmail = await cipher.tryDecrypt(account.email_address_enc);
                const custom = settings.email_enc ? await cipher.tryDecrypt(settings.email_enc) : null;
                email = custom || accountEmail;
                if (email && accountEmail) {
                    try {
                        sendAccount = {
                            credentials: await decryptCredentials(cipher, account.credentials_enc),
                            fromEmail: accountEmail
                        };
                    } catch {
                        // Undecryptable credentials — leave sendAccount null, no sender available.
                    }
                }
            }
        }

        const webhook =
            settings?.webhook_enabled === 1 && settings.webhook_enc
                ? await cipher.tryDecrypt(settings.webhook_enc)
                : null;

        return { email, sendAccount, webhook };
    }

    /** Send a sample alert on every configured channel (settings "Tester"). */
    async sendTestAlert(userId: number): Promise<{ sent: boolean; error: string | null }> {
        const channels = await this.resolveChannels(userId);
        if (!channels.sendAccount && !channels.webhook) {
            return {
                sent: false,
                error: 'Aucun canal de notification activé (choisissez un compte mail « open » ou un webhook).'
            };
        }
        const at = Math.floor(Date.now() / 1000);
        const body = [
            'Ceci est un test de notification DevEye Uptime.',
            '',
            `Envoyé le : ${formatMoment(at)}`,
            'Si vous lisez ce message, les alertes de disponibilité vous parviendront bien.'
        ].join('\n');

        let error: string | null = null;
        let sent = false;
        if (channels.email && channels.sendAccount) {
            try {
                await mailClient.sendMail(channels.sendAccount.credentials, {
                    from: channels.sendAccount.fromEmail,
                    to: [{ name: null, address: channels.email }],
                    subject: 'DevEye — test de notification',
                    text: body
                });
                sent = true;
            } catch (e) {
                error = e instanceof Error ? e.message : String(e);
            }
        }
        if (channels.webhook) {
            try {
                const response = await fetch(channels.webhook, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    signal: AbortSignal.timeout(10_000),
                    body: JSON.stringify(webhookPayload({ event: 'test', service: null, url: null, at, body }))
                });
                if (response.ok) sent = true;
                else error ??= await webhookRejection(response);
            } catch (e) {
                error ??= e instanceof Error ? e.message : String(e);
            }
        }
        return { sent, error: sent ? null : error };
    }
}
