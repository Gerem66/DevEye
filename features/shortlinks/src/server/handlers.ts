import {
    defineSdkFeature,
    FeatureError,
    normaliseDomainHost,
    type SdkCipher,
    type SdkDomain,
    type SdkShareScope
} from '@deveye/types/sdk/server';
import QRCode from 'qrcode';

// Le garde des appels sortants, partagé par toute l'app : une destination vers
// le réseau privé du visiteur (sa box, une imprimante) est refusée comme une
// adresse sondée, et le contrôle quotidien la suit avec ce même garde.
import { isAllowedOutboundUrl, OUTBOUND_REFUSED_MESSAGE } from '@/Services/netFetch';

import {
    shortlinksAdd,
    shortlinksCheckNow,
    shortlinksCount,
    shortlinksGet,
    shortlinksList,
    shortlinksQr,
    shortlinksRemove,
    shortlinksSetEnabled,
    shortlinksStats,
    shortlinksUpdate,
    shortlinksUpdateAccess,
    shortlinksUpdateCampaign
} from '../contracts/commands';
import {
    EMPTY_UTM,
    normaliseSlug,
    SHORTLINK_RECENT_DAYS,
    SHORTLINK_SLUG_PATTERN,
    type Shortlink,
    type ShortlinkStatus,
    type ShortlinkUsage
} from '../contracts/domain';
import {
    dayOf,
    domainUrlOf,
    hashPassword,
    instanceHosts,
    isDuplicate,
    isExpired,
    newCode,
    now,
    openContent,
    runtime,
    sealContent,
    shortUrlOf,
    type Ctx,
    type LinkContent
} from './_shared';
import type { LinkRow } from './repo';
import { buildStats } from './stats';

const CODE_ATTEMPTS = 5;

/**
 * Un lien visible depuis cet espace : le sien, ou un que l'on y projette.
 * `ctx.items.assert` refuse en plus ceux qu'une restriction masque ou passe en
 * lecture seule.
 */
async function loadLink(ctx: Ctx, id: number, level: 'read' | 'write' = 'read'): Promise<LinkRow> {
    const row = await ctx.repo.links.findVisible(id, ctx.workspaceId);
    if (!row) throw new FeatureError('not_found', 'Ce lien n’existe plus.');
    await ctx.items.assert(String(id), level);
    return row;
}

/** Les liens que ce rôle voit : ceux qu'une restriction masque disparaissent, plutôt que de paraître grisés. */
async function visibleLinks(ctx: Ctx): Promise<LinkRow[]> {
    const [rows, hidden] = await Promise.all([ctx.repo.links.listVisible(ctx.workspaceId), ctx.items.restrictions()]);
    return rows.filter((row) => hidden.get(String(row.id)) !== 'none');
}

export function statusOf(row: LinkRow, planPaused: boolean, at: number): ShortlinkStatus {
    if (row.blocked_at !== null) return 'blocked';
    if (planPaused) return 'planPaused';
    if (row.enabled !== 1) return 'disabled';
    if (isExpired(row, at, runtime()?.pendingLinkVisits(row.id) ?? 0)) return 'expired';
    return 'active';
}

interface ViewContext {
    ctx: Ctx;
    domains: ReadonlyMap<number, SdkDomain>;
    recent: ReadonlyMap<number, number[]>;
}

function toLink(view: ViewContext, row: LinkRow, content: LinkContent): Shortlink {
    const domain = row.domain_id === null ? undefined : view.domains.get(row.domain_id);
    const at = now();
    return {
        id: row.id,
        title: content.title,
        code: row.code,
        shortUrl: shortUrlOf(view.ctx.origins, row.code),
        domainId: row.domain_id,
        domainHost: domain?.host ?? null,
        slug: row.slug,
        domainUrl: domain?.verified && row.slug !== null ? domainUrlOf(domain.host, row.slug) : null,
        targets: {
            default: content.targets.default,
            ios: content.targets.ios,
            android: content.targets.android
        },
        utm: content.utm,
        hasPassword: row.password_hash !== null,
        expiresAt: row.expires_at === null ? null : Number(row.expires_at),
        maxVisits: row.max_visits === null ? null : Number(row.max_visits),
        visits: Number(row.visits_total),
        clicks: Number(row.clicks_total),
        recent: view.recent.get(row.id) ?? new Array<number>(SHORTLINK_RECENT_DAYS).fill(0),
        enabled: row.enabled === 1,
        status: statusOf(row, view.ctx.quota.isPaused('links', String(row.id)), at),
        blockedReason: row.blocked_at === null ? null : (row.blocked_reason ?? ''),
        check: {
            enabled: row.check_enabled === 1,
            state: row.check_state === 'ok' || row.check_state === 'broken' ? row.check_state : 'unknown',
            checkedAt: row.checked_at === null ? null : Number(row.checked_at),
            error: row.check_error
        },
        foreign: row.workspace_id !== view.ctx.workspaceId,
        created: Number(row.created),
        updated: Number(row.updated)
    };
}

/** Les visites des derniers jours, par lien, jours vides compris. */
async function recentOf(ctx: Ctx, rows: readonly LinkRow[]): Promise<Map<number, number[]>> {
    const today = dayOf(now());
    const first = today - SHORTLINK_RECENT_DAYS + 1;
    const out = new Map<number, number[]>();
    for (const row of await ctx.repo.stats.recent(
        rows.map((r) => r.id),
        first
    )) {
        const series = out.get(row.link_id) ?? new Array<number>(SHORTLINK_RECENT_DAYS).fill(0);
        const at = row.day - first;
        if (at >= 0 && at < SHORTLINK_RECENT_DAYS) series[at] = row.visits;
        out.set(row.link_id, series);
    }
    return out;
}

async function toLinks(ctx: Ctx, rows: readonly LinkRow[]): Promise<Shortlink[]> {
    const [scope, domains, recent] = await Promise.all([ctx.sharing.scope(), ctx.domains.list(), recentOf(ctx, rows)]);
    const view: ViewContext = { ctx, domains: new Map(domains.map((d) => [d.id, d])), recent };
    return Promise.all(
        rows.map(async (row) =>
            toLink(view, row, await openContent(await scope.cipherFor(String(row.id)), row.content))
        )
    );
}

async function toOne(ctx: Ctx, row: LinkRow): Promise<Shortlink> {
    const [link] = await toLinks(ctx, [row]);
    return link;
}

/** La clé de l'espace où vit le lien : un lien projeté reste scellé sous celle de son domicile. */
async function homeCipher(ctx: Ctx, id: number): Promise<SdkCipher> {
    return (await ctx.sharing.scope()).cipherFor(String(id));
}

/** Une destination où l'on peut envoyer un visiteur : publique, en http(s), jamais vers DevEye lui-même. */
function assertTarget(ctx: Ctx, url: string | null): void {
    if (url === null) return;
    if (!isAllowedOutboundUrl(url)) throw new FeatureError('validation', OUTBOUND_REFUSED_MESSAGE);
    const host = normaliseDomainHost(new URL(url).host);
    if (instanceHosts(ctx.origins).includes(host)) {
        throw new FeatureError('validation', 'Un lien court ne peut pas mener à une adresse de DevEye.');
    }
}

/** L'adresse choisie : sur DevEye seul, ou sur un domaine de cet espace sous un alias libre. */
async function addressOf(
    ctx: Ctx,
    domainId: number | null,
    rawSlug: string | null
): Promise<{ domainId: number | null; slug: string | null }> {
    if (domainId === null) return { domainId: null, slug: null };
    const domain = await ctx.domains.get(domainId);
    if (domain === null) throw new FeatureError('validation', 'Ce domaine n’appartient pas à cet espace.');
    const slug = normaliseSlug(rawSlug ?? '');
    if (!SHORTLINK_SLUG_PATTERN.test(slug)) {
        throw new FeatureError(
            'validation',
            'Le nom du lien ne garde que des lettres minuscules, des chiffres et des tirets (go.exemple.fr/promo-ete).'
        );
    }
    return { domainId, slug };
}

function slugConflict(error: unknown): never {
    if (isDuplicate(error)) throw new FeatureError('conflict', 'Ce nom est déjà pris sur ce domaine.');
    throw error;
}

async function usageOf(ctx: Ctx): Promise<ShortlinkUsage> {
    const [links, visits] = await Promise.all([
        ctx.quota.usage('links').catch(() => null),
        ctx.quota.usage('visits').catch(() => null)
    ]);
    return { links, visits };
}

export const linkHandlers = [
    defineSdkFeature({
        ...shortlinksCount,
        handler: async (ctx: Ctx) => {
            const rows = await visibleLinks(ctx);
            const at = now();
            const active = rows.filter(
                (row) => statusOf(row, ctx.quota.isPaused('links', String(row.id)), at) === 'active'
            ).length;
            const visitsToday = await ctx.repo.stats.visitsOn(
                rows.map((row) => row.id),
                dayOf(at)
            );
            return { total: rows.length, active, visitsToday };
        }
    }),

    defineSdkFeature({
        ...shortlinksList,
        handler: async (ctx: Ctx) => {
            const rows = await visibleLinks(ctx);
            const [links, usage] = await Promise.all([toLinks(ctx, rows), usageOf(ctx)]);
            return { links, usage };
        }
    }),

    defineSdkFeature({
        ...shortlinksGet,
        handler: async (ctx: Ctx, input) => ({ link: await toOne(ctx, await loadLink(ctx, input.id)) })
    }),

    defineSdkFeature({
        ...shortlinksAdd,
        access: { level: 'write' },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            const draft = input.link;
            assertTarget(ctx, draft.target);
            const address = await addressOf(ctx, draft.domainId, draft.slug);
            await ctx.quota.assert('links', async (owned) => (await ctx.repo.links.countIn(owned)) + 1);
            const content = await sealContent(ctx.cipher(), {
                title: draft.title,
                targets: { default: draft.target, ios: null, android: null },
                utm: EMPTY_UTM
            });
            let id: number | null = null;
            for (let attempt = 0; id === null; attempt++) {
                try {
                    id = await ctx.repo.links.create({
                        workspaceId: ctx.workspaceId,
                        userId: ctx.userId,
                        code: newCode(),
                        ...address,
                        content,
                        at: now()
                    });
                } catch (error) {
                    // Un code tiré deux fois se retire ; un alias déjà pris se dit.
                    if (isDuplicate(error) && String((error as Error).message).includes('uniq_ft_shortlinks_code')) {
                        if (attempt + 1 < CODE_ATTEMPTS) continue;
                        throw new FeatureError('internal', 'Aucun code libre trouvé, réessayez.');
                    }
                    slugConflict(error);
                }
            }
            runtime()?.forget(id);
            ctx.audit({ action: 'shortlinks.add', description: 'Lien court créé', metadata: { linkId: id } });
            const row = await ctx.repo.links.findById(id);
            if (!row) throw new FeatureError('internal', 'Le lien n’a pas pu être relu.');
            return { link: await toOne(ctx, row) };
        }
    }),

    defineSdkFeature({
        ...shortlinksUpdate,
        access: { level: 'write' },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            const row = await loadLink(ctx, input.id, 'write');
            const draft = input.link;
            for (const url of [draft.targets.default, draft.targets.ios, draft.targets.android]) assertTarget(ctx, url);
            const foreign = row.workspace_id !== ctx.workspaceId;
            const wanted = foreign
                ? { domainId: row.domain_id, slug: row.slug }
                : await addressOf(ctx, draft.domainId, draft.slug);
            if (
                foreign &&
                (draft.domainId !== row.domain_id ||
                    (draft.domainId !== null && normaliseSlug(draft.slug ?? '') !== row.slug))
            ) {
                throw new FeatureError(
                    'validation',
                    'L’adresse d’un lien partagé se règle depuis son espace d’origine.'
                );
            }
            const cipher = await homeCipher(ctx, row.id);
            const current = await openContent(cipher, row.content);
            const content = await sealContent(cipher, {
                ...current,
                title: draft.title,
                targets: { default: draft.targets.default, ios: draft.targets.ios, android: draft.targets.android }
            });
            await ctx.repo.links
                .update(row.id, row.workspace_id, { content, ...wanted, checkEnabled: draft.checkTarget, at: now() })
                .catch(slugConflict);
            runtime()?.forget(row.id);
            ctx.audit({ action: 'shortlinks.update', description: 'Lien court modifié', metadata: { linkId: row.id } });
            return { link: await toOne(ctx, await loadLink(ctx, row.id)) };
        }
    }),

    defineSdkFeature({
        ...shortlinksUpdateAccess,
        access: { level: 'write' },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            const row = await loadLink(ctx, input.id, 'write');
            // Une date déjà passée fait expirer le lien tout de suite : l'écran le dit avant d'enregistrer.
            const access = input.access;
            const passwordHash =
                access.password.mode === 'keep'
                    ? undefined
                    : access.password.mode === 'clear'
                      ? null
                      : await hashPassword(access.password.value);
            await ctx.repo.links.updateAccess(row.id, row.workspace_id, {
                passwordHash,
                expiresAt: access.expiresAt,
                maxVisits: access.maxVisits,
                at: now()
            });
            runtime()?.forget(row.id);
            ctx.audit({
                action: 'shortlinks.updateAccess',
                description: 'Accès d’un lien court modifié',
                metadata: { linkId: row.id }
            });
            return { link: await toOne(ctx, await loadLink(ctx, row.id)) };
        }
    }),

    defineSdkFeature({
        ...shortlinksUpdateCampaign,
        access: { level: 'write' },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            const row = await loadLink(ctx, input.id, 'write');
            const cipher = await homeCipher(ctx, row.id);
            const current = await openContent(cipher, row.content);
            await ctx.repo.links.updateContent(
                row.id,
                row.workspace_id,
                await sealContent(cipher, { ...current, utm: input.utm }),
                now()
            );
            runtime()?.forget(row.id);
            return { link: await toOne(ctx, await loadLink(ctx, row.id)) };
        }
    }),

    defineSdkFeature({
        ...shortlinksSetEnabled,
        access: { level: 'write' },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            const row = await loadLink(ctx, input.id, 'write');
            await ctx.repo.links.setEnabled(row.id, row.workspace_id, input.enabled, now());
            runtime()?.forget(row.id);
            return { link: await toOne(ctx, await loadLink(ctx, row.id)) };
        }
    }),

    defineSdkFeature({
        ...shortlinksRemove,
        access: { level: 'write' },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            const row = await loadLink(ctx, input.id, 'write');
            // Supprimer depuis un espace qui ne fait que le voir détruirait le lien d'un autre.
            if (row.workspace_id !== ctx.workspaceId) {
                throw new FeatureError(
                    'forbidden',
                    'Ce lien appartient à un autre espace. Retirez-le d’ici depuis ses réglages de partage, ou supprimez-le depuis son espace d’origine.'
                );
            }
            await ctx.repo.links.remove(row.id, row.workspace_id);
            await ctx.items.forget(String(row.id));
            runtime()?.forget(row.id);
            ctx.audit({
                action: 'shortlinks.remove',
                description: 'Lien court supprimé',
                metadata: { linkId: row.id }
            });
            return { id: row.id };
        }
    }),

    defineSdkFeature({
        ...shortlinksStats,
        handler: async (ctx: Ctx, input) => {
            const rows = input.id === null ? await visibleLinks(ctx) : [await loadLink(ctx, input.id)];
            const scope: SdkShareScope = await ctx.sharing.scope();
            // Une étiquette s'ouvre avec la clé de son espace : celle d'un lien de cet espace parmi ceux qu'on voit.
            const linkOfWorkspace = new Map(rows.map((row) => [row.workspace_id, row.id]));
            const stats = await buildStats({
                repo: ctx.repo,
                linkIds: rows.map((row) => row.id),
                range: input.range,
                cipherOf: async (workspaceId) => {
                    const linkId = linkOfWorkspace.get(workspaceId);
                    return linkId === undefined ? null : scope.cipherFor(String(linkId));
                },
                attribution: runtime()?.deps.geo.attribution ?? { text: '', url: '' }
            });
            return { stats };
        }
    }),

    defineSdkFeature({
        ...shortlinksQr,
        handler: async (ctx: Ctx, input) => {
            const link = await toOne(ctx, await loadLink(ctx, input.id));
            const url = input.address === 'domain' ? link.domainUrl : link.shortUrl;
            if (url === null)
                throw new FeatureError('validation', 'Ce lien n’a pas encore d’adresse sur un domaine vérifié.');
            const svg = await QRCode.toString(url, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' });
            return { url, svg };
        }
    }),

    defineSdkFeature({
        ...shortlinksCheckNow,
        access: { level: 'write' },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            const row = await loadLink(ctx, input.id, 'write');
            const service = runtime();
            if (service === null) throw new FeatureError('internal', 'Le contrôle des destinations est arrêté.');
            await service.checkNow(row);
            return { link: await toOne(ctx, await loadLink(ctx, row.id)) };
        }
    })
];
