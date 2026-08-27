import type { UptimeServiceRow, UptimeStatus } from '../contracts/domain';
import type { FeatureService, FeatureServiceDeps, SdkCipher } from '@deveye/types/sdk/server';

// Privilège de native rapatriée, commenté à chaque usage : l'horodatage et la
// durée des corps d'alerte sont ceux de `Services/notifications`, partagés par
// les cinq émetteurs de l'app (une alerte de base horodatée autrement qu'une
// alerte de disponibilité donnerait l'impression de venir d'un autre produit).
import { formatDuration, formatMoment } from '@/Services/notifications';

import { decryptError, decryptService, encryptError, type ServicePayload } from './_shared';
import { buildNotice, type UptimeNotice } from './notice';
import type { UptimeRepo } from './repo';

/**
 * Uptime scheduler (process singleton).
 *
 * Every tick it claims the services whose next probe is due, runs them with a
 * bounded concurrency, and writes back three things at once: the raw ping, its
 * daily rollup, and the service's live state. Outages are materialised as
 * incidents (opened when a service crosses its `failure_threshold`, closed on
 * the first success), which is also what makes notifications exactly-once: an
 * alert belongs to an incident, not to a probe.
 *
 * It runs with **no session and no password**, so every encrypted field it
 * touches (target, error messages, notification channels) goes through the
 * workspace's *open* cipher (`deps.cipherFor`, mémoïsé par le SDK) ; voir
 * `Docs/SECURITY_MODEL.md`.
 *
 * Depuis le rapatriement, la boucle est un ticker du SDK (`deps.createTicker`,
 * le patron des services natifs : setInterval + garde de réentrance + unref),
 * et l'élagage horaire des pings bruts, qui vivait dans le balayage de
 * rétention d'`index.ts`, est un second ticker du module.
 */

/**
 * Les variables d'environnement propres à la feature se lisent ici, pas dans
 * `Utils/Env` : la cadence de réveil (recherche des services à sonder) et le
 * nombre de sondes menées en parallèle.
 */
const TICK_SECONDS = Number(process.env.UPTIME_TICK_SECONDS) || 10;
const CONCURRENCY = Number(process.env.UPTIME_CONCURRENCY) || 8;
/** L'élagage des pings bruts : une fois par heure, comme le balayage de rétention de l'app. */
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/** Outcome of a single HTTP probe. */
export interface ProbeOutcome {
    up: boolean;
    httpStatus: number | null;
    responseMs: number | null;
    /** Plaintext failure reason, or null on success. */
    error: string | null;
}

/** La sonde elle-même, injectable : les tests en simulent une, sans réseau. */
export type ProbeFn = (target: ServicePayload, row: UptimeServiceRow) => Promise<ProbeOutcome>;

/** How long a probe body is read before giving up on the keyword match. */
const KEYWORD_BODY_MAX_BYTES = 512 * 1024;

/** Run one HTTP probe. Never throws: a failure *is* the result. */
export async function probeService(target: ServicePayload, row: UptimeServiceRow): Promise<ProbeOutcome> {
    const started = Date.now();
    try {
        const response = await fetch(target.url, {
            method: row.method,
            signal: AbortSignal.timeout(row.timeout_seconds * 1000),
            redirect: 'follow',
            headers: { 'user-agent': 'DevEye-Uptime/1.0' }
        });
        const httpStatus = response.status;

        // The body is only read when a keyword is expected; otherwise the probe
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
        // connection-level failure (DNS, refused, TLS...), whose `cause` carries
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
 * Le message lui-même n'est pas construit ici : `deliver` porte le texte
 * (`content` pour Discord, `text` pour Slack) et `UptimeNotice` la mise en page
 * Discord. Ce qui reste est ce que ni l'un ni l'autre ne dit : de quel service
 * il s'agit, et quand.
 */
function webhookPayload(alert: {
    event: 'down' | 'recovered';
    service: string;
    url: string;
    at: number;
}): Record<string, unknown> {
    return { event: alert.event, service: alert.service, url: alert.url, at: alert.at };
}

export class UptimeMonitor {
    /** La boucle des sondes, et l'élagage horaire : deux tickers du SDK. */
    private readonly ticker: FeatureService;
    private readonly pruner: FeatureService;
    /** Guards against a slow tick overlapping the next one. */
    private ticking = false;
    /**
     * Probes currently running, by service id. A second request for the same
     * service joins the running one instead of starting its own: two concurrent
     * probes could each open an incident, and only the newest would ever be
     * closed. `uptime.checkNow` landing on a scheduled tick is that race.
     */
    private readonly inFlight = new Map<number, Promise<void>>();

    constructor(
        private readonly deps: FeatureServiceDeps<UptimeRepo>,
        private readonly probe: ProbeFn = probeService
    ) {
        this.ticker = deps.createTicker({ intervalMs: TICK_SECONDS * 1000, tick: () => this.tick() });
        this.pruner = deps.createTicker({ intervalMs: PRUNE_INTERVAL_MS, tick: () => this.prune() });
    }

    start(): void {
        this.ticker.start();
        this.pruner.start();
        // Un tour tout de suite, comme avant : un serveur qui redémarre ne
        // laisse pas ses services attendre le premier réveil. L'élagage aussi,
        // au boot puis toutes les heures, comme le balayage de rétention.
        void this.tick();
        void this.prune();
        this.deps.logger.info({ tickSeconds: TICK_SECONDS }, 'Uptime monitor started');
    }

    stop(): void {
        this.ticker.stop();
        this.pruner.stop();
    }

    /** Claim every due service and probe them, `UPTIME_CONCURRENCY` at a time. */
    private async tick(): Promise<void> {
        if (this.ticking) return;
        this.ticking = true;
        try {
            const now = Math.floor(Date.now() / 1000);
            const due = await this.deps.repo.services.listDue(now, CONCURRENCY * 4);
            for (let i = 0; i < due.length; i += CONCURRENCY) {
                await Promise.all(due.slice(i, i + CONCURRENCY).map((row) => this.runOne(row)));
            }
        } catch (e) {
            this.deps.logger.error({ err: e instanceof Error ? e.message : String(e) }, 'Uptime tick failed');
        } finally {
            this.ticking = false;
        }
    }

    /**
     * Uptime : élagage des pings bruts selon la rétention de chaque service
     * (l'agrégat journalier, lui, n'est jamais purgé).
     */
    private async prune(): Promise<void> {
        try {
            const uptimeChecks = await this.deps.repo.history.pruneByRetention(Math.floor(Date.now() / 1000));
            if (uptimeChecks > 0) this.deps.logger.info({ uptimeChecks }, 'Pruned old uptime checks');
        } catch (e) {
            this.deps.logger.error(
                { err: e instanceof Error ? e.message : String(e) },
                'Uptime retention sweep failed'
            );
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
            const cipher = this.deps.cipherFor(row.workspace_id);
            const target = await decryptService(cipher, row.content);
            const outcome = target.url
                ? await this.probe(target, row)
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
        cipher: SdkCipher
    ): Promise<void> {
        const { repo } = this.deps;
        const at = Math.floor(Date.now() / 1000);
        const encryptedError = await encryptError(cipher, outcome.error);

        await repo.history.addCheck({
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

        await repo.services.recordProbe(row.id, {
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
            this.deps.live.changed(row.workspace_id);
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
        cipher: SdkCipher
    ): Promise<void> {
        const { repo } = this.deps;
        const open = await repo.history.openIncident(row.id);

        if (probe.status === 'down' && !open) {
            const incident = await repo.history.openIncidentAt({
                serviceId: row.id,
                startedAt: probe.at,
                httpStatus: probe.httpStatus,
                error: probe.encryptedError
            });
            this.deps.audit({
                level: 'error',
                action: 'uptime.down',
                userId: row.user_id,
                description: `Service « ${target.name} » injoignable`,
                metadata: { serviceId: row.id, httpStatus: probe.httpStatus }
            });
            // Toujours tenté : c'est la route qui décide. Un service réglé
            // « silencieux » a une route sans canal, la façade ne fait alors
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
            if (sent) await repo.history.markIncidentNotified(incident.id);
            return;
        }

        if (probe.up && open) {
            await repo.history.closeIncident(open.id, probe.at);
            const duration = Math.max(0, probe.at - open.started_at);
            this.deps.audit({
                action: 'uptime.recovered',
                userId: row.user_id,
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
     * Le corps de l'envoi vit dans `Services/notifications.ts`, derrière la
     * façade `notify` du SDK : `send` rend `false` sans canal routé, et c'est
     * ce booléen qui marque l'incident `notified`, donc ce qui interdit
     * d'envoyer un « c'est revenu » sans avoir envoyé le « c'est tombé ».
     *
     * `itemId` est passé, et c'est ce qui active la surcharge par élément :
     * un service qui a sa propre route écrit là où elle dit, les autres suivent
     * celle d'Uptime. Sans cet argument la fonctionnalité entière partagerait
     * un seul jeu de destinations, ce qui était précisément la limite d'avant.
     */
    private async notify(
        row: UptimeServiceRow,
        target: ServicePayload,
        alert: { subject: string; body: string; notice: UptimeNotice }
    ): Promise<boolean> {
        return this.deps.deveyeFor(row.workspace_id).notify.send(
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
            { itemId: row.id }
        );
    }
}
