import { audienceActivity, audienceBreakdown, audienceLive, audienceOverview } from '../contracts/commands';
import { AUDIENCE_BREAKDOWN_MAX, type AudienceBreakdownItem } from '../contracts/domain';
import { defineSdkFeature, type SdkCipher } from '@deveye/types/sdk/server';

import type { AudienceBreakdownRow } from './repo';
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
