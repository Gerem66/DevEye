import {
    AUDIENCE_BREAKDOWN_MAX,
    audienceActivity,
    audienceBreakdown,
    audienceLive,
    audienceOverview,
    type AudienceBreakdownItem
} from 'deveye-types';

import type { AudienceBreakdownRow } from '@/db/repos/audience';
import type { Cipher } from '@/Services/SecureStore';
import { defineFeature, type FeatureDefinition } from '../_define';
import { audienceCipher, loadSite, rangeWindow, READ, readLabel, toMetrics } from './_shared';

/**
 * Ce qu'on lit d'un site.
 *
 * Quatre commandes, toutes en lecture seule, toutes bornées par une fenêtre.
 * Aucune ne déchiffre plus que ce qu'elle rend : les nombres viennent d'un
 * `GROUP BY` sur des entiers, et seuls les intitulés effectivement affichés —
 * quelques dizaines — passent par une clé. C'est tout l'objet de la table de
 * dimensions (migration `076`).
 *
 * **Rien ici ne dépend de l'état de l'ingestion.** Les statistiques sortent des
 * dépôts, jamais de la file en mémoire du service : deux lectures successives
 * doivent rendre la même chose, qu'une vidange soit en cours ou non.
 */

/** Combien de lignes un classement rend par défaut. Au-delà, on scrute. */
const BREAKDOWN_DEFAULT = 8;

/** La fenêtre du « en ce moment ». Cinq minutes, la convention du domaine. */
const LIVE_WINDOW_SECONDS = 300;

async function toItems(cipher: Cipher, rows: AudienceBreakdownRow[]): Promise<AudienceBreakdownItem[]> {
    return Promise.all(
        rows.map(async (row) => ({
            label: await readLabel(cipher, row.content),
            views: row.views,
            visitors: row.visitors
        }))
    );
}

export const audienceOverviewFeature: FeatureDefinition<
    typeof audienceOverview.command,
    typeof audienceOverview.input,
    typeof audienceOverview.output
> = defineFeature({
    ...audienceOverview,
    access: READ,
    handler: async (ctx, input) => {
        const site = await loadSite(ctx, input.siteId);
        const now = Math.floor(Date.now() / 1000);
        const window = rangeWindow(input.range, now);
        const span = window.to - window.from;

        // En mode anonyme, le sel du visiteur tourne chaque jour : personne n'y
        // est jamais « déjà venu », et la requête rendrait toujours zéro. On ne
        // la pose donc pas, plutôt que de payer deux balayages pour un nombre
        // dont on connaît d'avance la valeur.
        const tracksReturning = site.visitor_mode === 'persistent';
        const returning = tracksReturning
            ? await Promise.all([
                  ctx.db.audience.returningVisitors(input.siteId, window.from, window.to),
                  ctx.db.audience.returningVisitors(input.siteId, window.from - span, window.from)
              ])
            : [0, 0];

        // La fenêtre précédente est **de même longueur et immédiatement
        // antérieure** : c'est ce qui rend la comparaison honnête. Comparer à
        // « le mois dernier » calendaire ferait varier le diviseur avec le
        // nombre de jours du mois, et un février paraîtrait toujours en baisse.
        const [metrics, previous, points] = await Promise.all([
            ctx.db.audience.metrics(input.siteId, window.from, window.to),
            ctx.db.audience.metrics(input.siteId, window.from - span, window.from),
            ctx.db.audience.points(input.siteId, window.from, window.to, window.bucket, window.from)
        ]);

        return {
            metrics: toMetrics(metrics, returning[0]),
            previous: toMetrics(previous, returning[1]),
            resolution: window.resolution,
            points
        };
    }
});

export const audienceBreakdownFeature: FeatureDefinition<
    typeof audienceBreakdown.command,
    typeof audienceBreakdown.input,
    typeof audienceBreakdown.output
> = defineFeature({
    ...audienceBreakdown,
    access: READ,
    handler: async (ctx, input) => {
        await loadSite(ctx, input.siteId);
        const window = rangeWindow(input.range, Math.floor(Date.now() / 1000));
        const limit = Math.min(input.limit ?? BREAKDOWN_DEFAULT, AUDIENCE_BREAKDOWN_MAX);
        const rows = await ctx.db.audience.breakdown(input.siteId, input.dimension, window.from, window.to, limit);
        return { items: await toItems(audienceCipher(ctx), rows) };
    }
});

export const audienceActivityFeature: FeatureDefinition<
    typeof audienceActivity.command,
    typeof audienceActivity.input,
    typeof audienceActivity.output
> = defineFeature({
    ...audienceActivity,
    access: READ,
    handler: async (ctx, input) => {
        await loadSite(ctx, input.siteId);
        const window = rangeWindow(input.range, Math.floor(Date.now() / 1000));
        const [cells, timezones] = await Promise.all([
            ctx.db.audience.activity(input.siteId, window.from, window.to),
            ctx.db.audience.breakdown(input.siteId, 'timezone', window.from, window.to, BREAKDOWN_DEFAULT)
        ]);
        return { cells, timezones: await toItems(audienceCipher(ctx), timezones) };
    }
});

export const audienceLiveFeature: FeatureDefinition<
    typeof audienceLive.command,
    typeof audienceLive.input,
    typeof audienceLive.output
> = defineFeature({
    ...audienceLive,
    access: READ,
    handler: async (ctx, input) => {
        await loadSite(ctx, input.siteId);
        const since = Math.floor(Date.now() / 1000) - LIVE_WINDOW_SECONDS;
        const [visitors, pages] = await Promise.all([
            ctx.db.audience.liveVisitors(input.siteId, since),
            ctx.db.audience.livePages(input.siteId, since, 5)
        ]);
        return { visitors, pages: await toItems(audienceCipher(ctx), pages) };
    }
});
