import type { UptimeServiceRow, UptimeStatus } from 'deveye-types';
import type { Logger } from 'pino';

import { decryptError, decryptService, encryptError, type ServicePayload } from '@/features/uptime/_shared';
import { createOpenCipher, type Cipher } from '@/Services/SecureStore';
import { buildNotice, type UptimeNotice } from '@/Services/notices/uptime';
import { deliver, formatDuration, formatMoment, resolveRoute, type ResolvedChannel } from '@/Services/notifications';
import { env } from '@/Utils/Env';

import type { LiveHub } from '@/live/hub';
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
    /**
     * Présence en direct. Cette boucle écrit sans commande utilisateur, donc
     * sans socket pour diffuser : c'est le hub qu'elle avertit directement.
     * Optionnel — les tests instancient le moniteur sans lui.
     */
    live?: LiveHub;
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
 * Les champs structurés d'une alerte, pour un point d'entrée maison qui veut
 * filtrer sans analyser du texte.
 *
 * Le message lui-même n'est plus construit ici : `deliver` porte le texte
 * (`content` pour Discord, `text` pour Slack) et `UptimeNotice` la mise en page
 * Discord. Ce qui reste est ce que ni l'un ni l'autre ne dit — de quel service
 * il s'agit, et quand.
 */
function webhookPayload(alert: {
    event: 'down' | 'recovered' | 'test';
    /** Null on a test alert, which is about no service in particular. */
    service: string | null;
    url: string | null;
    at: number;
}): Record<string, unknown> {
    return { event: alert.event, service: alert.service, url: alert.url, at: alert.at };
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

    /** Codec de l'étage ouvert d'un espace, mémoïsé pour la durée du process. */
    private cipherFor(workspaceId: number): Cipher {
        let cipher = this.ciphers.get(workspaceId);
        if (!cipher) {
            cipher = createOpenCipher(this.deps.db, this.deps.crypt, workspaceId);
            this.ciphers.set(workspaceId, cipher);
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
            const cipher = this.cipherFor(row.workspace_id);
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

        // Uniquement sur une **transition d'état**, jamais à chaque tour.
        //
        // La boucle tourne toutes les dix secondes sur tous les services : y
        // diffuser sans condition ferait re-solliciter le serveur par tous les
        // clients de tous les espaces, en permanence. Ce qui intéresse une
        // interface, c'est le moment où un service tombe ou revient.
        if (status !== row.status) {
            this.deps.live?.changed(row.workspace_id, ['uptime'], null);
        }

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
            // Toujours tenté : c'est la route qui décide. Un service réglé
            // « silencieux » a une route sans canal, `deliver` ne fait alors
            // rien et l'incident reste non-notifié, donc pas de « c'est
            // revenu » orphelin. (L'interrupteur `notify` par service a été
            // retiré : deux endroits décidaient d'une même alerte, migration 090.)
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
                notice: {
                    event: 'down',
                    service: target.name,
                    url: target.url,
                    at: probe.at,
                    error: probe.error,
                    httpStatus: probe.httpStatus
                }
            });
            if (sent) await db.uptimeHistory.markIncidentNotified(incident.id);
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
            // outage (no channel reached at the time) doesn't produce a lone
            // "back online" mail with no context.
            if (open.notified === 1) {
                const cause = await decryptError(cipher, open.error);
                await this.notify(row, target, {
                    subject: `✅ ${target.name} est de retour`,
                    body: [
                        `Le service « ${target.name} » répond de nouveau.`,
                        '',
                        `URL             : ${target.url}`,
                        `Panne du        : ${formatMoment(open.started_at)}`,
                        `Rétabli le      : ${formatMoment(probe.at)}`,
                        `Durée           : ${formatDuration(duration)}`,
                        `Cause initiale  : ${cause ?? 'inconnue'}`
                    ].join('\n'),
                    notice: {
                        event: 'recovered',
                        service: target.name,
                        url: target.url,
                        at: probe.at,
                        startedAt: open.started_at,
                        cause,
                        responseMs: probe.responseMs
                    }
                });
            }
        }
    }

    /**
     * Livre une alerte sur chaque canal réglé, et dit si l'un d'eux l'a acceptée.
     *
     * Le corps de l'envoi vit dans `Services/notifications.ts` : il était
     * recopié ici, mot pour mot, alors que ce module existait déjà pour l'éviter
     * — il ne servait qu'à Sentinelle. Le booléen rendu est ce qui marque
     * l'incident `notified`, et donc ce qui interdit d'envoyer un « c'est
     * revenu » sans avoir envoyé le « c'est tombé ».
     */
    private async notify(
        row: UptimeServiceRow,
        target: ServicePayload,
        alert: { subject: string; body: string; notice: Extract<UptimeNotice, { event: 'down' | 'recovered' }> }
    ): Promise<boolean> {
        return deliver(
            await this.resolveChannels(row.workspace_id, row.id),
            {
                subject: alert.subject,
                body: alert.body,
                payload: webhookPayload({
                    event: alert.notice.event,
                    service: target.name,
                    url: target.url,
                    at: alert.notice.at
                }),
                // La même alerte, mise en page pour Discord. Le corps en clair
                // au-dessus reste ce que reçoivent le mail et les autres
                // webhooks : rien n'est remplacé, une forme est ajoutée.
                embeds: buildNotice(alert.notice)
            },
            this.deps.logger.child({ serviceId: row.id })
        );
    }

    /**
     * Les canaux d'un service surveillé.
     *
     * `serviceId` est passé, et c'est ce qui active la surcharge par élément :
     * un service qui a sa propre route écrit là où elle dit, les autres suivent
     * celle d'Uptime. Sans cet argument la fonctionnalité entière partagerait
     * un seul jeu de destinations, ce qui était précisément la limite d'avant.
     */
    private async resolveChannels(workspaceId: number, serviceId?: number): Promise<ResolvedChannel[]> {
        return resolveRoute(this.deps.db, this.cipherFor(workspaceId), workspaceId, 'uptime', serviceId);
    }
}
