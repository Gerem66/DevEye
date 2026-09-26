import { createHash } from 'node:crypto';

import {
    normaliseDomainHost,
    type FeatureServiceDeps,
    type SdkDomain,
    type SdkPublicApp,
    type SdkPublicReply,
    type SdkPublicRequest
} from '@deveye/types/sdk/server';
import { defaultUserColor, USER_COLORS } from '@deveye/types';
import { DEVEYE_ICON_PATH } from '@deveye/types/sdk';

import { PROJECT_SLUG_PATTERN, PUBLIC_PATH, type ProjectPublicRow } from '../../contracts/domain';
import { decryptCard, decryptColumn, decryptMilestone, priorityFromDb, tryDecryptProject } from '../_shared';
import { WELL_KNOWN_PATH } from '../domains';
import { themeOf } from '../publication';
import { publicStockId, type ProjectsRepo } from '../repo';
import { renderBoardPage, renderMissingPage, type RenderOptions } from './render';
import { BOARD_SCRIPT, BOARD_SCRIPT_ETAG } from './script';
import { buildBoardView, type PublicMember } from './view';

/**
 * Les routes publiques des tableaux, et la racine des domaines qui les servent.
 * Aucune session : le tableau se désigne par son lien, par son chemin sous un
 * domaine, ou par le domaine dont il tient la racine.
 *
 * Un tableau se calcule au plus une fois toutes les trente secondes, un calcul à
 * la fois : un lien partagé largement attire tout le monde au même moment.
 *
 * Son icône d'onglet est la vignette du projet, servie à la même adresse suivie
 * de `?icone`, sous les mêmes gardes que la page ; sans vignette, celle de
 * DevEye (`DEVEYE_ICON_PATH`). À part plutôt qu'en ligne : la page se relit
 * chaque minute, l'icône une fois.
 */

const PAGE_PATH = `${PUBLIC_PATH}/:ref`;
const SCRIPT_PATH = `${PUBLIC_PATH}/page.js`;
const CACHE_MS = 30_000;
const REF_PATTERN = /^[0-9a-f]{16}$/;
const PAGE_RATE = { max: 300, timeWindow: '1 minute' };

/**
 * Tout est en ligne sauf le script, servi d'ici ; la vignette du projet est une
 * URL de données. La page se laisse intégrer dans le site de son propriétaire.
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

interface IconFile {
    bytes: Buffer;
    type: string;
    etag: string;
}

interface Cached {
    expires: number;
    row: ProjectPublicRow;
    html: string;
    /** La vignette du projet ; `null` sans vignette, l'icône de DevEye la remplace. */
    icon: IconFile | null;
}

function iconFile(bytes: Buffer, type: string): IconFile {
    return { bytes, type, etag: `"${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}"` };
}

/** Une vignette déjà validée par la vue : une image, jamais un SVG qui porterait du script. */
const ICON_DATA = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+=*)$/;

function iconOf(dataUrl: string): IconFile | null {
    const match = ICON_DATA.exec(dataUrl);
    return match ? iconFile(Buffer.from(match[2], 'base64'), match[1]) : null;
}

/** `?icone` : l'icône d'onglet de la page plutôt que la page. */
function wantsIcon(req: SdkPublicRequest): boolean {
    const query = req.query;
    return typeof query === 'object' && query !== null && Object.prototype.hasOwnProperty.call(query, 'icone');
}

function paramOf(bag: unknown, name: string): string {
    const value = (bag as Record<string, unknown> | undefined)?.[name];
    return typeof value === 'string' ? value : '';
}

export interface PublicPages {
    routes(app: SdkPublicApp): void;
    root(req: SdkPublicRequest, reply: SdkPublicReply, domain: SdkDomain): Promise<unknown>;
    /** Après une écriture : le tableau se recalcule à la prochaine visite. */
    forget(projectId: number): void;
}

export function createPublicPages(deps: FeatureServiceDeps<ProjectsRepo>): PublicPages {
    const originHosts = new Set([new URL(deps.origins.public).hostname, new URL(deps.origins.app).hostname]);
    const options: RenderOptions = { siteUrl: deps.origins.site ?? '', scriptPath: SCRIPT_PATH };
    /** Par clé de recherche : `ref:<lien>`, `slug:<domaine>:<chemin>` ou `root:<domaine>`. */
    const cache = new Map<string, Cached>();
    const pending = new Map<string, Promise<Cached | null>>();
    /** Un oubli pendant un calcul rend son résultat périmé : il ne se range pas. */
    let generation = 0;

    const hostOf = (req: SdkPublicRequest) => normaliseDomainHost(req.host ?? '');
    /**
     * En ligne, ouvert, et pas tenu en pause par l'offre. Le palier est revérifié
     * ici : le serveur n'a pas la clé d'un projet gardé, et sa publication tombe
     * avec la conversion.
     */
    const served = (row: ProjectPublicRow) =>
        row.enabled === 1 &&
        row.security_tier === 'open' &&
        !deps.pauses.isPaused('pages', publicStockId(row.project_id));

    async function membersOf(workspaceId: number): Promise<Map<number, PublicMember>> {
        const members = await deps.membersFor(workspaceId).list();
        // La teinte finit dans un nom de classe : hors de la palette, celle d'office.
        const colorOf = (m: (typeof members)[number]) =>
            m.color !== null && USER_COLORS.includes(m.color) ? m.color : defaultUserColor(m.userId);
        return new Map(members.map((m) => [m.userId, { name: m.name, color: colorOf(m) }]));
    }

    async function build(row: ProjectPublicRow): Promise<{ html: string; icon: IconFile | null } | null> {
        const workspaceId = row.workspace_id;
        const project = await deps.repo.projects.findById(row.project_id, workspaceId);
        if (!project) return null;
        const cipher = deps.cipherFor(workspaceId);
        const showDates = row.show_dates === 1;
        const showAssignees = row.show_assignees === 1;
        const [payload, columnRows, cardRows, milestoneRows, members] = await Promise.all([
            tryDecryptProject(cipher, project.content),
            deps.repo.board.listColumns(project.id, workspaceId),
            deps.repo.board.listCards(project.id, workspaceId, false),
            showDates ? deps.repo.plan.listMilestones(project.id, workspaceId) : Promise.resolve([]),
            showAssignees ? membersOf(workspaceId) : Promise.resolve(new Map<number, PublicMember>())
        ]);
        const [columns, cards, milestones] = await Promise.all([
            Promise.all(columnRows.map(async (c) => ({ row: c, name: (await decryptColumn(cipher, c.content)).name }))),
            Promise.all(cardRows.map(async (c) => ({ row: c, ...(await decryptCard(cipher, c.content)) }))),
            Promise.all(milestoneRows.map(async (m) => ({ row: m, ...(await decryptMilestone(cipher, m.content)) })))
        ]);
        const view = buildBoardView({
            now: Math.floor(Date.now() / 1000),
            project: {
                title: payload?.title ?? '',
                icon: payload?.icon ?? '',
                description: payload?.description ?? '',
                version: payload?.version ?? '',
                status: project.status
            },
            columns,
            cards,
            milestones,
            members,
            priorityOf: priorityFromDb,
            showDates,
            showAssignees,
            showSubtasks: row.show_subtasks === 1,
            theme: themeOf(row),
            accent: row.accent
        });
        return { html: renderBoardPage(view, options), icon: iconOf(view.icon) };
    }

    /** Le tableau d'une clé, calculé une fois pour tous ceux qui le demandent en même temps. */
    function compute(key: string, find: () => Promise<ProjectPublicRow | null>): Promise<Cached | null> {
        const hit = cache.get(key);
        if (hit && hit.expires > Date.now()) return Promise.resolve(hit);
        const running = pending.get(key);
        if (running) return running;
        const started = generation;
        const task = (async () => {
            const row = await find();
            if (!row || !served(row)) return null;
            const built = await build(row);
            if (built === null) return null;
            const entry = { expires: Date.now() + CACHE_MS, row, ...built };
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
     * Le tableau d'une clé, servable. La pause d'offre se relit après le cache :
     * une entrée qui ne sert plus se recalcule une fois, ce qui passe la racine
     * d'un domaine au projet suivant.
     */
    async function lookup(key: string, find: () => Promise<ProjectPublicRow | null>): Promise<Cached | null> {
        const entry = await compute(key, find);
        if (!entry) return null;
        if (served(entry.row)) return entry;
        if (cache.get(key) === entry) cache.delete(key);
        const again = await compute(key, find);
        return again && served(again.row) ? again : null;
    }

    /**
     * Sous l'adresse de DevEye, ou sous un domaine vérifié de l'espace du projet :
     * sans quoi n'importe qui ferait paraître son tableau sous le domaine d'un autre.
     */
    async function servedHere(req: SdkPublicRequest, workspaceId: number): Promise<boolean> {
        const host = hostOf(req);
        if (originHosts.has(host)) return true;
        const domain = host.length > 0 ? await deps.domains.findByHost(host) : null;
        return domain !== null && domain.verified && domain.workspaceId === workspaceId;
    }

    /** Le premier projet servable d'un domaine en tient la racine. */
    async function rootOf(domain: SdkDomain): Promise<ProjectPublicRow | null> {
        const rows = await deps.repo.publication.listOnDomain(domain.id);
        return rows.find((row) => row.workspace_id === domain.workspaceId && served(row)) ?? null;
    }

    function sendHtml(req: SdkPublicRequest, reply: SdkPublicReply, status: number, html: string) {
        reply
            .code(status)
            .header('content-type', 'text/html; charset=utf-8')
            .header('content-security-policy', CSP)
            .header('x-frame-options', '')
            .header('cache-control', 'no-store');
        // Sous l'adresse de DevEye, le tableau n'a rien à faire dans un moteur de
        // recherche ; sous le domaine de son propriétaire, il est sa page à lui.
        if (status !== 200 || originHosts.has(hostOf(req))) reply.header('x-robots-tag', 'noindex, nofollow');
        return reply.send(html);
    }

    /**
     * La vignette, revalidée à chaque visite : le propriétaire peut en changer.
     * Retirée depuis que la page a été servie, l'icône de DevEye la remplace.
     */
    function sendIcon(req: SdkPublicRequest, reply: SdkPublicReply, icon: IconFile | null) {
        if (icon === null) return reply.code(302).header('location', DEVEYE_ICON_PATH).send();
        reply.header('etag', icon.etag).header('cache-control', 'no-cache').header('x-content-type-options', 'nosniff');
        if (req.headers['if-none-match'] === icon.etag) return reply.code(304).send();
        return reply.header('content-type', icon.type).send(icon.bytes);
    }

    const serve = (req: SdkPublicRequest, reply: SdkPublicReply, hit: Cached) =>
        wantsIcon(req) ? sendIcon(req, reply, hit.icon) : sendHtml(req, reply, 200, hit.html);

    const missing = (req: SdkPublicRequest, reply: SdkPublicReply) =>
        wantsIcon(req) ? reply.code(404).send() : sendHtml(req, reply, 404, renderMissingPage(options));

    /** Le chemin d'un projet sous le domaine vérifié de l'hôte, s'il y en a un. */
    async function bySlug(req: SdkPublicRequest, slug: string): Promise<Cached | null> {
        if (!PROJECT_SLUG_PATTERN.test(slug)) return null;
        const host = hostOf(req);
        if (host.length === 0 || originHosts.has(host)) return null;
        const domain = await deps.domains.findByHost(host);
        if (!domain?.verified) return null;
        const hit = await lookup(`slug:${domain.id}:${slug}`, () => deps.repo.publication.findBySlug(domain.id, slug));
        return hit && hit.row.workspace_id === domain.workspaceId ? hit : null;
    }

    return {
        routes(app) {
            app.get(SCRIPT_PATH, { rateLimit: PAGE_RATE }, async (req, reply) => {
                reply.header('etag', BOARD_SCRIPT_ETAG).header('cache-control', 'public, max-age=3600');
                if (req.headers['if-none-match'] === BOARD_SCRIPT_ETAG) return reply.code(304).send();
                return reply.header('content-type', 'application/javascript; charset=utf-8').send(BOARD_SCRIPT);
            });

            app.get(PAGE_PATH, { rateLimit: PAGE_RATE }, async (req, reply) => {
                const ref = paramOf(req.params, 'ref');
                const underDomain = await bySlug(req, ref);
                if (underDomain) return serve(req, reply, underDomain);
                const hit = REF_PATTERN.test(ref)
                    ? await lookup(`ref:${ref}`, () => deps.repo.publication.findByRef(ref))
                    : null;
                if (!hit || !(await servedHere(req, hit.row.workspace_id))) return missing(req, reply);
                return serve(req, reply, hit);
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
            const hit = await lookup(`root:${domain.id}`, () => rootOf(domain));
            if (!hit || hit.row.workspace_id !== domain.workspaceId) return missing(req, reply);
            return serve(req, reply, hit);
        },

        forget(projectId) {
            generation += 1;
            for (const [key, entry] of cache) {
                // Une racine peut changer de projet quand un autre la rejoint ou la quitte.
                if (entry.row.project_id === projectId || key.startsWith('root:')) cache.delete(key);
            }
            // Un calcul en cours a lu l'ancien tableau : la visite suivante n'attend pas son résultat.
            pending.clear();
        }
    };
}
