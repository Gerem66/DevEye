import {
    normaliseDomainHost,
    type FeatureServiceDeps,
    type SdkDomain,
    type SdkPublicApp,
    type SdkPublicReply,
    type SdkPublicRequest
} from '@deveye/types/sdk/server';

import { UPTIME_PAGE_DAYS, type UptimePageRow } from '../../contracts/domain';
import { decryptError, decryptPage, decryptService, STATUS_PATH } from '../_shared';
import { WELL_KNOWN_PATH } from '../domains';
import type { UptimeRepo } from '../repo';
import { pageStockId } from '../repoPages';
import { renderMissingPage, renderStatusPage, type RenderOptions } from './render';
import { STATUS_SCRIPT, STATUS_SCRIPT_ETAG } from './script';
import { buildStatusView, DAY, LATENCY_HOURS } from './view';

/**
 * Les routes publiques des pages de statut, et la racine des domaines qui les
 * servent. Aucune session : la page se désigne par son lien, ou par le domaine
 * sous lequel on la demande.
 *
 * Une page se calcule au plus une fois toutes les trente secondes, un calcul à
 * la fois : une panne attire tout le monde au même moment, et c'est alors que
 * la base doit rester libre pour les sondes.
 */

const PAGE_PATH = `${STATUS_PATH}/:ref`;
const SCRIPT_PATH = `${STATUS_PATH}/page.js`;
const CACHE_MS = 30_000;
/** Au-delà, l'historique des barres est de toute façon rouge de bout en bout. */
const INCIDENTS_MAX = 1_000;
const REF_PATTERN = /^[0-9a-f]{16}$/;
const PAGE_RATE = { max: 300, timeWindow: '1 minute' };

/**
 * Tout est en ligne sauf le script et l'icône d'onglet, servis d'ici ; la page
 * se laisse intégrer dans le site de son propriétaire.
 */
const CSP = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    "script-src 'self'",
    "connect-src 'self'",
    "img-src data: 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    'frame-ancestors *'
].join('; ');

interface Cached {
    expires: number;
    row: UptimePageRow;
    html: string;
}

function paramOf(bag: unknown, name: string): string {
    const value = (bag as Record<string, unknown> | undefined)?.[name];
    return typeof value === 'string' ? value : '';
}

export interface StatusPages {
    routes(app: SdkPublicApp): void;
    root(req: SdkPublicRequest, reply: SdkPublicReply, domain: SdkDomain): Promise<unknown>;
    /** Après une écriture : la page se recalcule à la prochaine visite. */
    forget(pageId: number): void;
}

export function createStatusPages(deps: FeatureServiceDeps<UptimeRepo>): StatusPages {
    const originHosts = new Set([new URL(deps.origins.public).hostname, new URL(deps.origins.app).hostname]);
    const options: RenderOptions = { siteUrl: deps.origins.site ?? '', scriptPath: SCRIPT_PATH };
    /** Par clé de recherche : `ref:<lien>` ou `domain:<id>`. */
    const cache = new Map<string, Cached>();
    const pending = new Map<string, Promise<Cached | null>>();
    /** Un oubli pendant un calcul rend son résultat périmé : il ne se range pas. */
    let generation = 0;

    const hostOf = (req: SdkPublicRequest) => normaliseDomainHost(req.host ?? '');
    /** Publiée, et pas tenue en pause par l'offre : une page en pause répond comme une page retirée. */
    const served = (row: UptimePageRow) => row.enabled === 1 && !deps.pauses.isPaused('pages', pageStockId(row.id));

    async function build(row: UptimePageRow): Promise<string> {
        const cipher = deps.cipherFor(row.workspace_id);
        const now = Math.floor(Date.now() / 1000);
        const firstDay = Math.floor(now / DAY) * DAY - (UPTIME_PAGE_DAYS - 1) * DAY;
        const firstHour = Math.floor(now / 3600) * 3600 - (LATENCY_HOURS - 1) * 3600;
        const services = await deps.repo.status.servicesOf(row.id, row.workspace_id);
        const ids = services.map((service) => service.id);
        const [page, daily, incidents, latency] = await Promise.all([
            decryptPage(cipher, row.content),
            deps.repo.status.dailyOf(ids, firstDay),
            deps.repo.status.incidentsOf(ids, firstDay, INCIDENTS_MAX),
            row.show_latency === 1 ? deps.repo.status.hourlyLatencyOf(ids, firstHour) : Promise.resolve([])
        ]);
        const named = await Promise.all(
            services.map(async (service) => {
                const label = service.page_label === null ? null : await cipher.tryDecrypt(service.page_label);
                const name = label || (await decryptService(cipher, service.content)).name;
                return {
                    row: service,
                    name: name || 'Service',
                    planPaused: deps.pauses.isPaused('monitors', String(service.id))
                };
            })
        );
        const withErrors = await Promise.all(
            incidents.map(async (incident) => ({
                row: incident,
                // Le message n'est ouvert que si la page en montre la nature, et
                // il n'en sort qu'une catégorie.
                error: row.show_errors === 1 ? await decryptError(cipher, incident.error) : null
            }))
        );
        const view = buildStatusView({
            now,
            title: page.title,
            description: page.description,
            theme: row.theme,
            showErrors: row.show_errors === 1,
            showLatency: row.show_latency === 1,
            services: named,
            daily,
            incidents: withErrors,
            latency
        });
        return renderStatusPage(view, options);
    }

    /**
     * La page d'une clé, servable. La pause d'offre se relit après le cache :
     * elle prend effet à la visite suivante, sans rien avoir à en oublier.
     */
    async function lookup(key: string, find: () => Promise<UptimePageRow | null>): Promise<Cached | null> {
        const entry = await compute(key, find);
        return entry && served(entry.row) ? entry : null;
    }

    /** La page d'une clé, calculée une fois pour tous ceux qui la demandent en même temps. */
    function compute(key: string, find: () => Promise<UptimePageRow | null>): Promise<Cached | null> {
        const hit = cache.get(key);
        if (hit && hit.expires > Date.now()) return Promise.resolve(hit);
        const running = pending.get(key);
        if (running) return running;
        const started = generation;
        const task = (async () => {
            const row = await find();
            if (!row || !served(row)) return null;
            const entry = { expires: Date.now() + CACHE_MS, row, html: await build(row) };
            if (started === generation) {
                for (const [k, v] of cache) if (v.expires <= Date.now()) cache.delete(k);
                cache.set(key, entry);
            }
            return entry;
        })();
        pending.set(key, task);
        const settle = () => {
            if (pending.get(key) === task) pending.delete(key);
        };
        task.then(settle, settle);
        return task;
    }

    /**
     * Sous l'adresse de DevEye, ou sous un domaine vérifié de l'espace de la
     * page : sans quoi n'importe qui ferait paraître sa page sous le domaine
     * d'un autre.
     */
    async function servedHere(req: SdkPublicRequest, workspaceId: number): Promise<boolean> {
        const host = hostOf(req);
        if (originHosts.has(host)) return true;
        const domain = host.length > 0 ? await deps.domains.findByHost(host) : null;
        return domain !== null && domain.verified && domain.workspaceId === workspaceId;
    }

    function sendHtml(req: SdkPublicRequest, reply: SdkPublicReply, status: number, html: string) {
        reply
            .code(status)
            .header('content-type', 'text/html; charset=utf-8')
            .header('content-security-policy', CSP)
            .header('x-frame-options', '')
            .header('cache-control', 'no-store');
        // Sous l'adresse de DevEye, la page n'a rien à faire dans un moteur de
        // recherche ; sous le domaine de son propriétaire, elle est sa page à lui.
        if (status !== 200 || originHosts.has(hostOf(req))) reply.header('x-robots-tag', 'noindex, nofollow');
        return reply.send(html);
    }

    const missing = (req: SdkPublicRequest, reply: SdkPublicReply) =>
        sendHtml(req, reply, 404, renderMissingPage(options));

    return {
        routes(app) {
            app.get(SCRIPT_PATH, { rateLimit: PAGE_RATE }, async (req, reply) => {
                reply.header('etag', STATUS_SCRIPT_ETAG).header('cache-control', 'public, max-age=3600');
                if (req.headers['if-none-match'] === STATUS_SCRIPT_ETAG) return reply.code(304).send();
                return reply.header('content-type', 'application/javascript; charset=utf-8').send(STATUS_SCRIPT);
            });

            app.get(PAGE_PATH, { rateLimit: PAGE_RATE }, async (req, reply) => {
                const ref = paramOf(req.params, 'ref');
                const hit = REF_PATTERN.test(ref)
                    ? await lookup(`ref:${ref}`, () => deps.repo.pages.findByRef(ref))
                    : null;
                if (!hit || !(await servedHere(req, hit.row.workspace_id))) return missing(req, reply);
                return sendHtml(req, reply, 200, hit.html);
            });

            /** La preuve que la sonde du domaine vient lire. Un hôte inconnu ne rend rien : la route ne dit pas quels noms existent. */
            app.get(WELL_KNOWN_PATH, { rateLimit: { max: 30, timeWindow: '1 minute' } }, async (req, reply) => {
                const host = hostOf(req);
                const domain = host.length > 0 ? await deps.domains.findByHost(host) : null;
                if (domain === null) return reply.code(404).send();
                return reply.header('content-type', 'text/plain; charset=utf-8').send(domain.token);
            });
        },

        async root(req, reply, domain) {
            const hit = await lookup(`domain:${domain.id}`, () => deps.repo.pages.findByDomain(domain.id));
            if (!hit || hit.row.workspace_id !== domain.workspaceId) return missing(req, reply);
            return sendHtml(req, reply, 200, hit.html);
        },

        forget(pageId) {
            generation += 1;
            for (const [key, entry] of cache) if (entry.row.id === pageId) cache.delete(key);
            // Un calcul en cours a lu l'ancienne page : la visite suivante n'attend pas son résultat.
            pending.clear();
        }
    };
}
