import {
    audienceActivity,
    audienceBreakdown,
    audienceLive,
    audienceOverview,
    audienceSummary
} from '../contracts/commands';
import { AUDIENCE_BREAKDOWN_MAX, type AudienceBreakdownItem } from '../contracts/domain';
import { defineSdkFeature, FeatureError, type SdkCipher } from '@deveye/types/sdk/server';

import { dayKey } from './normalize';
import type { AudienceBreakdownRow, ResolvedStep } from './repo';
import { loadSite, rangeWindow, readLabel, siteCipher, toMetrics, type Ctx } from './_shared';

/**
 * Ce qu'on lit d'un site : quatre commandes en lecture seule, bornées par une
 * fenêtre. Aucune ne déchiffre plus que ce qu'elle rend, les nombres venant
 * d'un `GROUP BY` sur des entiers ; c'est l'objet de la table de dimensions.
 *
 * Rien ici ne dépend de l'état de l'ingestion : les statistiques sortent du
 * dépôt, jamais de sa file en mémoire, pour que deux lectures successives
 * rendent la même chose.
 */

const BREAKDOWN_DEFAULT = 8;

/** La fenêtre du « en ce moment ». Cinq minutes, la convention du domaine. */
const LIVE_WINDOW_SECONDS = 300;

/** Ce que couvrent les cartes du sommaire : une semaine, la courbe comprise. */
const SUMMARY_DAYS = 7;

async function toItems(cipher: SdkCipher, rows: AudienceBreakdownRow[]): Promise<AudienceBreakdownItem[]> {
    return Promise.all(
        rows.map(async (row) => ({
            label: await readLabel(cipher, row.content),
            views: row.views,
            visitors: row.visitors
        }))
    );
}

export const audienceOverviewFeature = defineSdkFeature({
    ...audienceOverview,
    handler: async (ctx: Ctx, input) => {
        const site = await loadSite(ctx, input.siteId);
        const now = Math.floor(Date.now() / 1000);
        const window = rangeWindow(input.range, now);
        const span = window.to - window.from;

        // En mode anonyme, le sel du visiteur tourne chaque jour : personne n'y est
        // jamais « déjà venu », la requête rendrait toujours zéro et on ne la pose pas.
        const tracksReturning = site.visitor_mode === 'persistent';
        const returning = tracksReturning
            ? await Promise.all([
                  ctx.repo.returningVisitors(input.siteId, window.from, window.to),
                  ctx.repo.returningVisitors(input.siteId, window.from - span, window.from)
              ])
            : [0, 0];

        // La fenêtre précédente est de même longueur et immédiatement antérieure :
        // comparer à « le mois dernier » calendaire ferait varier le diviseur avec le
        // nombre de jours, et un février paraîtrait toujours en baisse.
        const [metrics, previous, points] = await Promise.all([
            ctx.repo.metrics(input.siteId, window.from, window.to),
            ctx.repo.metrics(input.siteId, window.from - span, window.from),
            ctx.repo.points(input.siteId, window.from, window.to, window.bucket, window.from)
        ]);

        return {
            metrics: toMetrics(metrics, returning[0]),
            previous: toMetrics(previous, returning[1]),
            resolution: window.resolution,
            points
        };
    }
});

export const audienceBreakdownFeature = defineSdkFeature({
    ...audienceBreakdown,
    handler: async (ctx: Ctx, input) => {
        await loadSite(ctx, input.siteId);
        const window = rangeWindow(input.range, Math.floor(Date.now() / 1000));
        const limit = Math.min(input.limit ?? BREAKDOWN_DEFAULT, AUDIENCE_BREAKDOWN_MAX);
        const rows = await ctx.repo.breakdown(input.siteId, input.dimension, window.from, window.to, limit);
        return { items: await toItems(await siteCipher(ctx, input.siteId), rows) };
    }
});

export const audienceActivityFeature = defineSdkFeature({
    ...audienceActivity,
    handler: async (ctx: Ctx, input) => {
        await loadSite(ctx, input.siteId);
        const window = rangeWindow(input.range, Math.floor(Date.now() / 1000));
        const [cells, timezones] = await Promise.all([
            ctx.repo.activity(input.siteId, window.from, window.to),
            ctx.repo.breakdown(input.siteId, 'timezone', window.from, window.to, BREAKDOWN_DEFAULT)
        ]);
        return { cells, timezones: await toItems(await siteCipher(ctx, input.siteId), timezones) };
    }
});

export const audienceLiveFeature = defineSdkFeature({
    ...audienceLive,
    handler: async (ctx: Ctx, input) => {
        await loadSite(ctx, input.siteId);
        const since = Math.floor(Date.now() / 1000) - LIVE_WINDOW_SECONDS;
        const [visitors, pages] = await Promise.all([
            ctx.repo.liveVisitors(input.siteId, since),
            ctx.repo.livePages(input.siteId, since, 5)
        ]);
        return { visitors, pages: await toItems(await siteCipher(ctx, input.siteId), pages) };
    }
});

export const audienceSummaryFeature = defineSdkFeature({
    ...audienceSummary,
    handler: async (ctx: Ctx, input) => {
        const home = await loadSite(ctx, input.siteId);
        const row = await ctx.repo.findWithStats(input.siteId, home.workspace_id);
        if (!row) throw new FeatureError('not_found', 'Site introuvable');
        const now = Math.floor(Date.now() / 1000);

        // Les retours n'ont rien à voir avec la mesure : un site statique peut ne
        // poser aucune balise et ne se servir que de ses formulaires, donc cette
        // carte se lit même quand rien n'a jamais été mesuré.
        const feedback = await ctx.repo.feedbackStats(input.siteId, now - SUMMARY_DAYS * 86400);

        // Rien de mesuré, rien à agréger : deux requêtes de trafic et une de
        // rétention rendraient des zéros au prix fort, à chaque battement de l'espace.
        if (row.last_event_at === null) {
            return {
                traffic: { views24h: 0, visitors24h: 0, days: [] },
                funnels: { count: 0, first: null },
                feedback
            };
        }

        const [rolled, funnels] = await Promise.all([
            // L'agrégat journalier plutôt que les événements : il survit à la
            // rétention, et une courbe de sommaire n'a pas besoin d'être à la minute.
            ctx.repo.dailyPoints(input.siteId, dayKey(now - (SUMMARY_DAYS - 1) * 86400)),
            firstFunnel(ctx, input.siteId, now)
        ]);

        // Les jours sans trafic n'ont pas de ligne : rendus tels quels, la semaine
        // se tasserait sur les seuls jours mesurés et une accalmie ressemblerait à
        // une courbe pleine.
        const views = new Map(rolled.map((point) => [point.day, point.views]));
        const days = Array.from({ length: SUMMARY_DAYS }, (_, i) => {
            const day = dayKey(now - (SUMMARY_DAYS - 1 - i) * 86400);
            return { day, views: views.get(day) ?? 0 };
        });

        return {
            traffic: { views24h: row.views_24h, visitors24h: row.visitors_24h, days },
            funnels,
            feedback
        };
    }
});

/**
 * Le nombre d'entonnoirs, et la conversion du premier seulement. Les mesurer
 * tous coûterait une requête de rétention par entonnoir pour une carte qu'on ne
 * fait que survoler ; la vue complète, elle, les calcule.
 */
async function firstFunnel(
    ctx: Ctx,
    siteId: number,
    now: number
): Promise<{ count: number; first: { name: string; rate: number } | null }> {
    const rows = await ctx.repo.listFunnels(siteId);
    const head = rows[0];
    if (!head) return { count: 0, first: null };

    const steps = (await ctx.repo.listFunnelSteps(siteId)).filter((step) => step.funnel_id === head.id);
    if (steps.length === 0) return { count: rows.length, first: null };

    const cipher = await siteCipher(ctx, siteId);
    const labels = await ctx.repo.resolveLabels(
        siteId,
        steps.map((step) => ({ kind: step.match_kind, labelRef: step.label_ref }))
    );
    const resolved: ResolvedStep[] = steps.map((step) => ({
        kind: step.match_kind === 'path' ? 'path' : 'event',
        labelId: labels.get(`${step.match_kind}:${step.label_ref}`) ?? null
    }));

    const window = rangeWindow('7d', now);
    const counts = await ctx.repo.retention(siteId, resolved, window.from, window.to);
    const entered = counts[0] ?? 0;
    return {
        count: rows.length,
        first: {
            name: (await readLabel(cipher, head.content)) || 'Sans nom',
            // Personne n'est entré : zéro, et non un NaN que zod rejetterait au retour.
            rate: entered > 0 ? (counts[counts.length - 1] ?? 0) / entered : 0
        }
    };
}
