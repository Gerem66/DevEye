import { randomBytes } from 'node:crypto';

import {
    looksLikeBot,
    normaliseDomainHost,
    type FeatureServiceDeps,
    type SdkDomain,
    type SdkHostRequest,
    type SdkPublicApp,
    type SdkPublicReply,
    type SdkPublicRequest
} from '@deveye/types/sdk/server';
import { z } from 'zod';

import {
    SHORTLINK_CODE_PATTERN,
    SHORTLINK_SLUG_PATTERN,
    SHORTLINKS_PATH,
    shortlinkReportReasonSchema,
    type ShortlinkReportReason
} from '../contracts/domain';
import {
    deviceOfAgent,
    destinationOf,
    domainUrlOf,
    instanceHosts,
    isExpired,
    now,
    openContent,
    SHORT_HOST,
    shortUrlOf,
    verifyPassword,
    type LinkContent
} from './_shared';
import type { Counters } from './counters';
import { reportMail } from './mails';
import {
    PAGE_CSP,
    renderBlocked,
    renderExpired,
    renderHome,
    renderMissing,
    renderPassword,
    renderPreview,
    renderReport,
    renderReportDone,
    renderUnavailable,
    type PageOptions
} from './render';
import type { LinkRow, ShortlinksRepo } from './repo';
import { sealReport } from './reports';

/**
 * Les routes publiques : la redirection elle-même, sous `/l/<code>` sur les
 * adresses de DevEye, à la racine du domaine court (`<code>`) et sous l'alias
 * d'un domaine de l'espace (`<alias>`), plus l'aperçu (`+`), le mot de passe et
 * le signalement. Aucune session : un lien se désigne par son adresse seule.
 *
 * Le chemin chaud ne touche la base qu'au premier passage d'un lien par
 * demi-minute : la ligne se garde en mémoire, oubliée à chaque écriture d'un
 * membre. La pause de l'offre se relit après le cache, sans rien à oublier.
 */

const CACHE_MS = 30_000;
const CACHE_MAX = 10_000;
const PAGE_RATE = { max: 120, timeWindow: '1 minute' };
/** Une personne qui essaie des mots de passe : une poignée par minute, pas davantage. */
const UNLOCK_RATE = { max: 10, timeWindow: '1 minute' };
/** Au-delà, les signalements de l'heure restent dans la page de modération sans mail aux administrateurs. */
const REPORT_MAILS_PER_HOUR = 30;
export const WELL_KNOWN_PATH = '/.well-known/deveye-shortlinks';

const unlockBody = z.object({ password: z.string().max(400).default('') });
const reportBody = z.object({
    reason: z.string().max(32).default(''),
    message: z.string().max(8_000).default(''),
    name: z.string().max(400).default(''),
    email: z.string().max(400).default(''),
    goodFaith: z.string().max(8).optional(),
    _hp: z.string().max(200).default('')
});
const emailSchema = z.email();

interface Resolved {
    row: LinkRow;
    content: LinkContent;
}

interface Cached {
    expires: number;
    hit: Resolved | null;
}

function paramOf(bag: unknown, name: string): string {
    const value = (bag as Record<string, unknown> | undefined)?.[name];
    return typeof value === 'string' ? value : '';
}

function headerOf(req: SdkPublicRequest, name: string): string | undefined {
    const value = req.headers[name];
    return Array.isArray(value) ? value[0] : value;
}

/** Ce que la pause de l'offre, l'administration ou son auteur décident d'un lien, au moment du passage. */
export type Gate = 'missing' | 'blocked' | 'expired' | 'unavailable' | 'open';

export interface Redirector {
    routes(app: SdkPublicApp): void;
    hostRequest(req: SdkHostRequest, reply: SdkPublicReply, domain: SdkDomain | null): Promise<unknown>;
    /** Après une écriture : le lien se relit au prochain passage. */
    forget(linkId: number): void;
}

export function createRedirector(deps: FeatureServiceDeps<ShortlinksRepo>, counters: Counters): Redirector {
    const options: PageOptions = { siteUrl: deps.origins.site ?? '' };
    const ownHosts = instanceHosts(deps.origins);
    const cache = new Map<string, Cached>();
    const loads = new Map<string, Promise<Resolved | null>>();
    /** Un oubli pendant une lecture rend son résultat périmé : il ne se range pas. */
    let generation = 0;

    function lookup(key: string, find: () => Promise<LinkRow | null>): Promise<Resolved | null> {
        const hit = cache.get(key);
        if (hit && hit.expires > Date.now()) return Promise.resolve(hit.hit);
        const running = loads.get(key);
        if (running) return running;
        const started = generation;
        const task = (async () => {
            const row = await find();
            const resolved = row
                ? { row, content: await openContent(deps.cipherFor(row.workspace_id), row.content) }
                : null;
            if (started === generation) {
                if (cache.size >= CACHE_MAX) cache.clear();
                cache.set(key, { expires: Date.now() + CACHE_MS, hit: resolved });
            }
            return resolved;
        })();
        loads.set(key, task);
        const settle = () => {
            if (loads.get(key) === task) loads.delete(key);
        };
        task.then(settle, settle);
        return task;
    }

    const byCode = (code: string) =>
        SHORTLINK_CODE_PATTERN.test(code) ? lookup(`code:${code}`, () => deps.repo.links.findByCode(code)) : null;

    const bySlug = (domain: SdkDomain, slug: string) =>
        SHORTLINK_SLUG_PATTERN.test(slug)
            ? lookup(`slug:${domain.id}:${slug}`, () => deps.repo.links.findBySlug(domain.id, slug))
            : null;

    async function gate(resolved: Resolved | null): Promise<Gate> {
        if (!resolved) return 'missing';
        const { row } = resolved;
        if (deps.pauses.isPaused('links', String(row.id))) return 'missing';
        if (row.blocked_at !== null) return 'blocked';
        if (row.enabled !== 1) return 'missing';
        if (isExpired(row, now(), counters.pendingLinkVisits(row.id))) return 'expired';
        if (!(await counters.allows(row.workspace_id))) return 'unavailable';
        return 'open';
    }

    function sendHtml(reply: SdkPublicReply, status: number, html: string) {
        return reply
            .code(status)
            .header('content-type', 'text/html; charset=utf-8')
            .header('content-security-policy', PAGE_CSP)
            .header('cache-control', 'no-store')
            .header('x-robots-tag', 'noindex, nofollow')
            .header('referrer-policy', 'no-referrer')
            .send(html);
    }

    function closed(reply: SdkPublicReply, verdict: Exclude<Gate, 'open'>) {
        switch (verdict) {
            case 'missing':
                return sendHtml(reply, 404, renderMissing(options));
            case 'blocked':
                return sendHtml(reply, 410, renderBlocked(options));
            case 'expired':
                return sendHtml(reply, 410, renderExpired(options));
            case 'unavailable':
                return sendHtml(reply, 503, renderUnavailable(options));
        }
    }

    /**
     * Sous un domaine de l'espace, ou sous une adresse de DevEye : sans quoi
     * n'importe qui ferait paraître un lien sous le domaine d'un autre.
     */
    async function servedHere(req: SdkPublicRequest, row: LinkRow): Promise<boolean> {
        const host = normaliseDomainHost(req.host ?? '');
        if (ownHosts.includes(host)) return true;
        const domain = host.length > 0 ? await deps.domains.findByHost(host) : null;
        return domain !== null && domain.verified && domain.workspaceId === row.workspace_id;
    }

    /** La redirection, une fois le lien ouvert ; HEAD et robots passent sans être comptés. */
    function redirect(req: SdkPublicRequest, reply: SdkPublicReply, resolved: Resolved, method: string, status = 302) {
        const userAgent = headerOf(req, 'user-agent') ?? '';
        const target = destinationOf(resolved.content.targets, resolved.content.utm, deviceOfAgent(userAgent));
        if (target === null) return sendHtml(reply, 404, renderMissing(options));
        if (method === 'GET' || method === 'POST') {
            if (looksLikeBot(userAgent)) counters.recordBot(resolved.row.id);
            else
                counters.record(
                    {
                        linkId: resolved.row.id,
                        workspaceId: resolved.row.workspace_id,
                        ip: req.ip,
                        userAgent,
                        referrer: headerOf(req, 'referer'),
                        acceptLanguage: headerOf(req, 'accept-language'),
                        ownHosts
                    },
                    deps.geo.country(req.ip)
                );
        }
        return reply
            .code(status)
            .header('location', target)
            .header('cache-control', 'private, no-store')
            .header('x-robots-tag', 'noindex, nofollow')
            .header('referrer-policy', 'no-referrer-when-downgrade')
            .send();
    }

    /** L'adresse où ce lien se partage sous cet hôte : sert de cible au bouton de l'aperçu. */
    function linkHere(req: SdkPublicRequest, row: LinkRow, domain: SdkDomain | null): string {
        if (domain !== null && row.slug !== null) return domainUrlOf(domain.host, row.slug);
        const host = normaliseDomainHost(req.host ?? '');
        if (SHORT_HOST !== null && host === SHORT_HOST) return shortUrlOf(deps.origins, row.code);
        return `${SHORTLINKS_PATH}/${row.code}`;
    }

    /** Un passage : la page qui convient, ou la redirection. */
    async function serve(
        req: SdkPublicRequest,
        reply: SdkPublicReply,
        resolved: Resolved | null,
        opts: { method: string; preview: boolean; domain: SdkDomain | null }
    ) {
        const verdict = await gate(resolved);
        if (verdict !== 'open') return closed(reply, verdict);
        if (resolved === null) return closed(reply, 'missing');
        const { row, content } = resolved;
        if (opts.preview) {
            const userAgent = headerOf(req, 'user-agent') ?? '';
            return sendHtml(
                reply,
                200,
                renderPreview(
                    {
                        title: content.title,
                        target:
                            row.password_hash === null
                                ? destinationOf(content.targets, content.utm, deviceOfAgent(userAgent))
                                : null,
                        link: linkHere(req, row, opts.domain),
                        report: `${SHORTLINKS_PATH}/${row.code}/signaler`
                    },
                    options
                )
            );
        }
        if (row.password_hash !== null) {
            return sendHtml(
                reply,
                401,
                renderPassword({ action: `${SHORTLINKS_PATH}/${row.code}/deverrouiller`, error: false }, options)
            );
        }
        return redirect(req, reply, resolved, opts.method);
    }

    /** `k3x9p2+` : l'aperçu de `k3x9p2`. */
    const splitPreview = (raw: string): { key: string; preview: boolean } =>
        raw.endsWith('+') ? { key: raw.slice(0, -1), preview: true } : { key: raw, preview: false };

    async function unlock(req: SdkPublicRequest, reply: SdkPublicReply) {
        const resolved = await byCode(paramOf(req.params, 'code'));
        if (!resolved || !(await servedHere(req, resolved.row))) return closed(reply, 'missing');
        const verdict = await gate(resolved);
        if (verdict !== 'open') return closed(reply, verdict);
        if (resolved.row.password_hash === null) return redirect(req, reply, resolved, 'POST', 303);
        const body = unlockBody.safeParse(req.body ?? {});
        const ok = body.success && (await verifyPassword(body.data.password, resolved.row.password_hash));
        if (!ok) {
            return sendHtml(
                reply,
                403,
                renderPassword(
                    { action: `${SHORTLINKS_PATH}/${resolved.row.code}/deverrouiller`, error: true },
                    options
                )
            );
        }
        return redirect(req, reply, resolved, 'POST', 303);
    }

    async function reportPage(req: SdkPublicRequest, reply: SdkPublicReply, submitted: boolean) {
        const code = paramOf(req.params, 'code');
        const resolved = await byCode(code);
        // Un lien retiré se signale encore : la trace d'un nouvel abus compte.
        if (!resolved || !(await servedHere(req, resolved.row))) return closed(reply, 'missing');
        const action = `${SHORTLINKS_PATH}/${code}/signaler`;
        const empty = { reason: '', message: '', name: '', email: '' };
        if (!submitted) return sendHtml(reply, 200, renderReport({ action, values: empty, error: null }, options));

        const parsed = reportBody.safeParse(req.body ?? {});
        if (!parsed.success || parsed.data._hp.length > 0) return closed(reply, 'missing');
        const input = parsed.data;
        const values = {
            reason: input.reason,
            message: input.message.trim(),
            name: input.name.trim(),
            email: input.email.trim()
        };
        const retry = (error: string) => sendHtml(reply, 400, renderReport({ action, values, error }, options));
        const reason = shortlinkReportReasonSchema.safeParse(values.reason);
        if (!reason.success) return retry('Choisissez un motif.');
        if (values.message.length < 10 || values.message.length > 4_000) {
            return retry('Décrivez ce qui pose problème en 10 à 4 000 caractères.');
        }
        if (values.name.length === 0 || values.name.length > 120) return retry('Indiquez votre nom.');
        if (!emailSchema.safeParse(values.email).success || values.email.length > 200) {
            return retry('Indiquez une adresse e-mail valide.');
        }
        if (input.goodFaith !== 'on') return retry('Cochez la déclaration de bonne foi.');

        const { row, content } = resolved;
        const ref = randomBytes(6).toString('hex').toUpperCase();
        const url = shortUrlOf(deps.origins, row.code);
        const target = destinationOf(content.targets, content.utm, 'other') ?? '';
        await deps.repo.reports.insert({
            ref,
            linkId: row.id,
            workspaceId: row.workspace_id,
            reason: reason.data,
            content: sealReport(deps.keys, ref, {
                url,
                title: content.title,
                target,
                message: values.message,
                name: values.name,
                email: values.email,
                ip: req.ip
            })
        });
        deps.audit({
            action: 'shortlinks.report',
            description: `Signalement ${ref} reçu sur un lien court.`,
            level: 'warning',
            metadata: { linkId: row.id, reason: reason.data }
        });
        void mailAdmins({
            ref,
            url,
            title: content.title,
            target,
            reason: reason.data,
            message: values.message,
            reporterName: values.name,
            reporterEmail: values.email,
            ip: req.ip
        });
        return sendHtml(reply, 200, renderReportDone(ref, options));
    }

    /** Le signalement est déjà en base : un mail qui ne part pas n'en perd rien, la page de modération le montre. */
    async function mailAdmins(input: {
        ref: string;
        url: string;
        title: string;
        target: string;
        reason: ShortlinkReportReason;
        message: string;
        reporterName: string;
        reporterEmail: string;
        ip: string;
    }) {
        try {
            if (!deps.accountMail.configured) return;
            if ((await deps.repo.reports.countSince(now() - 3_600)) > REPORT_MAILS_PER_HOUR) return;
            await deps.accountMail.sendToAdmins(reportMail({ ...input, origins: deps.origins }));
        } catch (error) {
            deps.logger.warn({ err: error, ref: input.ref }, 'shortlinks: mail de signalement non parti');
        }
    }

    return {
        routes(app) {
            app.get(`${SHORTLINKS_PATH}/:code`, { rateLimit: PAGE_RATE }, async (req, reply) => {
                const { key, preview } = splitPreview(paramOf(req.params, 'code'));
                const resolved = await byCode(key);
                if (resolved && !(await servedHere(req, resolved.row))) return closed(reply, 'missing');
                return serve(req, reply, resolved ?? null, { method: req.method ?? 'GET', preview, domain: null });
            });
            app.post(`${SHORTLINKS_PATH}/:code/deverrouiller`, { rateLimit: UNLOCK_RATE, bodyLimit: 4_096 }, unlock);
            app.get(
                `${SHORTLINKS_PATH}/:code/signaler`,
                { rateLimit: { max: 30, timeWindow: '1 minute' } },
                (req, reply) => reportPage(req, reply, false)
            );
            app.post(
                `${SHORTLINKS_PATH}/:code/signaler`,
                { rateLimit: { max: 5, timeWindow: '1 minute' }, bodyLimit: 16_384 },
                (req, reply) => reportPage(req, reply, true)
            );
            /** La preuve que la sonde du domaine vient lire. Un hôte inconnu ne rend rien. */
            app.get(WELL_KNOWN_PATH, { rateLimit: { max: 30, timeWindow: '1 minute' } }, async (req, reply) => {
                const host = normaliseDomainHost(req.host ?? '');
                const domain = host.length > 0 ? await deps.domains.findByHost(host) : null;
                if (domain === null) return reply.code(404).send();
                return reply.header('content-type', 'text/plain; charset=utf-8').send(domain.token);
            });
        },

        async hostRequest(req, reply, domain) {
            let segment: string;
            try {
                segment = decodeURIComponent(req.path.slice(1));
            } catch {
                return sendHtml(reply, 404, renderMissing(options));
            }
            if (segment.includes('/')) return sendHtml(reply, 404, renderMissing(options));
            if (domain === null) {
                // Le domaine court de l'instance : les codes à la racine, le site vitrine à `/`.
                if (segment === '') {
                    return deps.origins.site
                        ? reply.code(302).header('location', deps.origins.site).send()
                        : sendHtml(reply, 200, renderHome(options));
                }
                const { key, preview } = splitPreview(segment);
                return serve(req, reply, await byCode(key), { method: req.method, preview, domain: null });
            }
            const { key, preview } = splitPreview(segment.toLowerCase());
            const resolved = await bySlug(domain, key);
            const mine = resolved !== null && resolved.row.workspace_id === domain.workspaceId ? resolved : null;
            return serve(req, reply, mine, { method: req.method, preview, domain });
        },

        forget(linkId) {
            generation += 1;
            // Les adresses inconnues aussi : un alias tout juste créé répondait « introuvable ».
            for (const [key, entry] of cache) if (entry.hit === null || entry.hit.row.id === linkId) cache.delete(key);
            // Une lecture en cours a vu l'ancien lien : le passage suivant ne l'attend pas.
            loads.clear();
        }
    };
}
