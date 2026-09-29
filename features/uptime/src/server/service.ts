import type { UptimeServiceRow, UptimeStatus } from '../contracts/domain';
import { mapLimit, type FeatureService, type FeatureServiceDeps, type SdkCipher } from '@deveye/types/sdk/server';

// Horodatage et durée partagés par tous les émetteurs de l'app : importés, pas recopiés.
import { formatDuration, formatMoment } from '@/Services/alertCore';
// Le garde des appels sortants, partagé par toute l'app : la sonde suit une
// adresse qu'un membre a saisie, et rend son statut et la présence d'un mot-clé.
import { safeFetch, UnsafeTargetError } from '@/Services/netFetch';

import {
    decryptBaseline,
    decryptError,
    decryptService,
    encryptBaseline,
    encryptError,
    type IntegrityBaseline,
    type ServicePayload
} from './_shared';
import { env } from './env';
import { captureSite, describeDrift, detailDrift, diffCapture, hasDrift, type IntegrityCapture } from './integrity';
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
 * workspace's *open* cipher (`deps.cipherFor`); see `Docs/SECURITY_MODEL.md`.
 */

/** Élagage des pings bruts, une fois par heure. */
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/** Outcome of a single probe. */
export interface ProbeOutcome {
    up: boolean;
    httpStatus: number | null;
    responseMs: number | null;
    /** Plaintext failure reason, or null on success. */
    error: string | null;
    /** Integrity: what the site serves now; becomes the reference when there is none yet. */
    capture?: IntegrityCapture;
    /** Integrity: the drift, file by file, for the incident and the alert. */
    driftLines?: string[];
}

/**
 * La sonde elle-même, injectable : les tests en simulent une, sans réseau.
 * `baseline` ne concerne que l'intégrité : la référence retenue, `null` tant
 * qu'aucune n'a été apprise.
 */
export type ProbeFn = (
    target: ServicePayload,
    row: UptimeServiceRow,
    baseline: IntegrityBaseline | null
) => Promise<ProbeOutcome>;

/** How long a probe body is read before giving up on the keyword match. */
const KEYWORD_BODY_MAX_BYTES = 512 * 1024;

/** Run one probe, of the service's kind. Never throws: a failure *is* the result. */
export async function probeService(
    target: ServicePayload,
    row: UptimeServiceRow,
    baseline: IntegrityBaseline | null
): Promise<ProbeOutcome> {
    return row.kind === 'integrity' ? probeIntegrity(target, row, baseline) : probeHttp(target, row);
}

/**
 * Integrity: refetch every file the site serves and compare. Without a
 * reference, the capture IS the result: `record` stores it as the reference
 * and the service is up. The document unreachable is a failure like any other.
 */
async function probeIntegrity(
    target: ServicePayload,
    row: UptimeServiceRow,
    baseline: IntegrityBaseline | null
): Promise<ProbeOutcome> {
    const started = Date.now();
    try {
        const capture = await captureSite(target.url, target.paths, row.timeout_seconds * 1000);
        const responseMs = Date.now() - started;
        if (!baseline) return { up: true, httpStatus: capture.documentStatus, responseMs, error: null, capture };
        const diff = diffCapture(baseline, capture);
        if (!hasDrift(diff)) return { up: true, httpStatus: capture.documentStatus, responseMs, error: null };
        return {
            up: false,
            httpStatus: capture.documentStatus,
            responseMs,
            error: describeDrift(diff),
            driftLines: detailDrift(diff)
        };
    } catch (e) {
        return { up: false, httpStatus: null, responseMs: Date.now() - started, error: failureMessage(e, row) };
    }
}

/** Ce qu'une lecture qui a échoué dit d'elle-même, sans le « fetch failed » générique de Node. */
function failureMessage(e: unknown, row: UptimeServiceRow): string {
    if (e instanceof UnsafeTargetError) return e.message;
    // AbortSignal.timeout rejects with a TimeoutError; everything else is a
    // connection-level failure (DNS, refused, TLS...), whose `cause` carries
    // the useful detail Node hides behind a generic "fetch failed".
    if (e instanceof Error && e.name === 'TimeoutError') return `Délai dépassé (${row.timeout_seconds} s)`;
    const cause = e instanceof Error && e.cause instanceof Error ? e.cause.message : null;
    return cause ?? (e instanceof Error ? e.message : String(e));
}

async function probeHttp(target: ServicePayload, row: UptimeServiceRow): Promise<ProbeOutcome> {
    const started = Date.now();
    try {
        const response = await safeFetch(target.url, {
            method: row.method,
            signal: AbortSignal.timeout(row.timeout_seconds * 1000),
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
        const timedOut = e instanceof Error && e.name === 'TimeoutError';
        return {
            up: false,
            httpStatus: null,
            responseMs: timedOut ? Date.now() - started : null,
            error: failureMessage(e, row)
        };
    }
}

/**
 * Les champs structurés d'une alerte, pour un point d'entrée maison qui filtre
 * sans analyser du texte : ce que ni le corps ni l'embed ne disent.
 */
function webhookPayload(alert: {
    event: 'down' | 'recovered' | 'integrity';
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
    private ticking: Promise<void> | null = null;
    private pruning: Promise<void> = Promise.resolve();
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
        this.ticker = deps.createTicker({ intervalMs: env.UPTIME_TICK_SECONDS * 1000, tick: () => this.tick() });
        this.pruner = deps.createTicker({ intervalMs: PRUNE_INTERVAL_MS, tick: () => this.prune() });
    }

    start(): void {
        this.ticker.start();
        this.pruner.start();
        // Un tour tout de suite : un serveur qui redémarre ne laisse pas ses
        // services attendre le premier réveil.
        void this.tick();
        this.pruning = this.prune();
        this.deps.logger.info({ tickSeconds: env.UPTIME_TICK_SECONDS }, 'Uptime monitor started');
    }

    async stop(): Promise<void> {
        await Promise.all([this.ticker.stop(), this.pruner.stop(), this.pruning]);
        await this.ticking;
    }

    /** Claim the due services and probe them, `UPTIME_CONCURRENCY` in flight at a time. */
    private tick(): Promise<void> {
        this.ticking ??= this.probeDue()
            .catch((e: unknown) =>
                this.deps.logger.error({ err: e instanceof Error ? e.message : String(e) }, 'Uptime tick failed')
            )
            .finally(() => {
                this.ticking = null;
            });
        return this.ticking;
    }

    private async probeDue(): Promise<void> {
        const now = Math.floor(Date.now() / 1000);
        const paused = this.deps.pauses.paused('monitors').map(Number);
        // Huit sondes par place et par tour : une sonde rapide libère la sienne
        // aussitôt, et un service qui tient jusqu'à son délai ne retient qu'elle.
        const due = await this.deps.repo.services.listDue(now, env.UPTIME_CONCURRENCY * 8, paused);
        await mapLimit(due, env.UPTIME_CONCURRENCY, (row) => this.runOne(row));
    }

    /**
     * Des services que l'offre vient de mettre en pause : leur panne en cours se
     * ferme, comme à une pause choisie, sans quoi la page publique la dirait
     * « en cours » et sa durée courrait sans que personne ne mesure plus rien.
     */
    async closeOutages(serviceIds: readonly number[]): Promise<void> {
        const at = Math.floor(Date.now() / 1000);
        for (const id of serviceIds) {
            const open = await this.deps.repo.history.openIncident(id);
            if (open) await this.deps.repo.history.closeIncident(open.id, at);
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
        // Relu ici aussi : l'offre peut mettre le service en pause entre la
        // liste des dus et son tour dans le lot.
        if (this.deps.pauses.isPaused('monitors', String(row.id))) return;
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
            const baseline = row.kind === 'integrity' ? await decryptBaseline(cipher, row.baseline_enc) : null;
            const outcome = target.url
                ? await this.probe(target, row, baseline)
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

        // Première lecture réussie d'un contrôle d'intégrité : ce que le site
        // sert devient la référence. Rien n'est comparé à ce tour-là.
        if (outcome.capture) {
            const { csp, files, source } = outcome.capture;
            await repo.services.setBaseline(
                row.id,
                await encryptBaseline(cipher, { capturedAt: at, csp, files, source })
            );
        }

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

        // Diffusé sur une transition d'état seulement : la boucle tourne toutes
        // les dix secondes sur tous les services, diffuser à chaque tour ferait
        // re-solliciter le serveur par tous les clients en permanence.
        if (status !== row.status) {
            this.deps.live.changed(row.workspace_id);
        }

        // L'incident porte le détail fichier par fichier ; la ligne du service
        // n'en garde que le résumé.
        const incidentError =
            outcome.driftLines && outcome.error
                ? await encryptError(cipher, [outcome.error, ...outcome.driftLines].join('\n'))
                : encryptedError;
        await this.reconcileIncident(row, target, { ...outcome, at, status, encryptedError: incidentError }, cipher);
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
            const drift = probe.driftLines ?? null;
            this.deps.audit({
                level: 'error',
                action: drift ? 'uptime.integrity' : 'uptime.down',
                userId: row.user_id,
                description: drift
                    ? `Fichiers de « ${target.name} » modifiés : ${probe.error}`
                    : `Service « ${target.name} » injoignable`,
                metadata: { serviceId: row.id, httpStatus: probe.httpStatus, ...(drift ? { drift } : {}) }
            });
            // Toujours tenté : c'est la route qui décide. Un service « silencieux »
            // a une route sans canal, la façade ne fait rien et l'incident reste
            // non-notifié, donc pas de « c'est revenu » orphelin.
            const sent = drift
                ? await this.notify(row, target, {
                      subject: `🛡️ ${target.name} : fichiers modifiés`,
                      body: [
                          `Les fichiers que sert « ${target.name} » ne sont plus ceux de la référence.`,
                          '',
                          `URL : ${target.url}`,
                          `Constaté : ${formatMoment(probe.at)}`,
                          `Écart : ${probe.error ?? 'inconnu'}`,
                          '',
                          ...drift,
                          '',
                          'Si c’est un déploiement voulu, acceptez la version actuelle depuis la fiche du service.'
                      ].join('\n'),
                      notice: { event: 'integrity', service: target.name, url: target.url, at: probe.at, lines: drift }
                  })
                : await this.notify(row, target, {
                      subject: `⚠️ ${target.name} est hors ligne`,
                      body: [
                          `Le service « ${target.name} » ne répond plus.`,
                          '',
                          `URL : ${target.url}`,
                          `Depuis : ${formatMoment(probe.at)}`,
                          `Erreur : ${probe.error ?? 'inconnue'}`,
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
                        `URL : ${target.url}`,
                        `Panne du : ${formatMoment(open.started_at)}`,
                        `Rétabli le : ${formatMoment(probe.at)}`,
                        `Durée : ${formatDuration(duration)}`,
                        `Cause initiale : ${cause ?? 'inconnue'}`
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
     * Livre une alerte sur chaque canal réglé et dit si l'un l'a acceptée : c'est
     * ce booléen qui marque l'incident `notified`, donc ce qui interdit un
     * « c'est revenu » sans « c'est tombé ». `itemId` active la route propre au
     * service ; sans lui, tout Uptime partagerait un seul jeu de destinations.
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
                // La même alerte, mise en page pour Discord ; le corps en clair
                // reste pour les autres canaux.
                embeds: buildNotice(alert.notice)
            },
            { itemId: row.id }
        );
    }
}
