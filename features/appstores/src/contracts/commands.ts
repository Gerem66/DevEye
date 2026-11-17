import { z } from 'zod';
import {
    APPSTORES_REPLY_MAX_LENGTH,
    APPSTORES_REVIEW_PAGE_MAX,
    appStoreSchema,
    appStoresAppInputSchema,
    appStoresAppSchema,
    appStoresAppSummarySchema,
    appStoresOverviewSchema,
    appStoresRangeSchema,
    appStoresRevenueSchema,
    appStoresReviewCursorSchema,
    appStoresReviewSchema,
    appStoresSourceInputSchema,
    appStoresSourceSchema,
    appStoresStatsSchema,
    appStoresStoreAppSchema,
    appStoresUsageSchema
} from './domain';

/**
 * Commandes de Stores, préfixe `appstores.`, le verbe en tête : le filet
 * `MUTATION_VERB` de `src/features/_topics.ts` repère ainsi un `mutates`
 * oublié sur `add`, `update`, `remove`. `testSource` et `replyReview` écrivent
 * sans que leur nom le dise : leur `mutates` se tient à la main.
 */

const appId = z.number().int().positive();
const sourceId = z.number().int().positive();

/** Les comptes de store de l'espace ; les secrets n'en sortent jamais. */
export const appStoresListSources = {
    command: 'appstores.listSources' as const,
    input: z.object({}),
    output: z.object({ sources: z.array(appStoresSourceSchema) })
};

/** Teste la clé avant de l'enregistrer : un refus net du store lève `validation`. */
export const appStoresAddSource = {
    command: 'appstores.addSource' as const,
    input: appStoresSourceInputSchema,
    output: z.object({ source: appStoresSourceSchema })
};

/** Le store ne change pas ; un secret absent garde celui en place. */
export const appStoresUpdateSource = {
    command: 'appstores.updateSource' as const,
    input: z.object({ sourceId, source: appStoresSourceInputSchema }),
    output: z.object({ source: appStoresSourceSchema })
};

/** Les fiches qui s'en servaient restent, sans source : leur synchronisation s'arrête et le dit. */
export const appStoresRemoveSource = {
    command: 'appstores.removeSource' as const,
    input: z.object({ sourceId }),
    output: z.object({ sourceId })
};

/** Resonde ce que la clé sait lire, et range le résultat. */
export const appStoresTestSource = {
    command: 'appstores.testSource' as const,
    input: z.object({ sourceId }),
    output: z.object({ source: appStoresSourceSchema })
};

/** Les apps qu'une clé voit chez son store, pour le choix à l'ajout. */
export const appStoresListStoreApps = {
    command: 'appstores.listStoreApps' as const,
    input: z.object({ sourceId }),
    output: z.object({ apps: z.array(appStoresStoreAppSchema) })
};

/** Le nombre d'apps de l'espace, pour la tuile de l'accueil. */
export const appStoresCount = {
    command: 'appstores.count' as const,
    input: z.object({}),
    output: z.object({ count: z.number().int().nonnegative() })
};

export const appStoresList = {
    command: 'appstores.list' as const,
    input: z.object({}),
    output: z.object({ apps: z.array(appStoresAppSummarySchema) })
};

/** Une app, avec les projets qui la relient. */
export const appStoresGet = {
    command: 'appstores.get' as const,
    input: z.object({ appId }),
    output: z.object({ app: appStoresAppSchema, usage: z.array(appStoresUsageSchema) })
};

/** Une app sans store est admise : elle attend sa sortie. */
export const appStoresAdd = {
    command: 'appstores.add' as const,
    input: appStoresAppInputSchema,
    output: z.object({ app: appStoresAppSchema })
};

/**
 * Une fiche de store garde son identité : changer d'app au store demande de
 * retirer la fiche (et son historique) puis d'en relier une autre.
 */
export const appStoresUpdate = {
    command: 'appstores.update' as const,
    input: appStoresAppInputSchema.extend({ appId }),
    output: z.object({ app: appStoresAppSchema })
};

/** Supprime l'app, ses chiffres, ses avis et ses liaisons aux projets. */
export const appStoresRemove = {
    command: 'appstores.remove' as const,
    input: z.object({ appId }),
    output: z.object({ appId })
};

/**
 * Relit l'année écoulée chez les stores, jusqu'au même mois de l'an dernier.
 * Rien n'est effacé : le service relance son rattrapage, et les chiffres se
 * complètent en quelques minutes.
 */
export const appStoresBackfill = {
    command: 'appstores.backfill' as const,
    input: z.object({ appId }),
    output: z.object({ app: appStoresAppSchema })
};

/** `store` restreint la lecture à ce store : sa fenêtre s'arrête alors à son propre dernier jour. */
export const appStoresStats = {
    command: 'appstores.stats' as const,
    input: z.object({ appId, range: appStoresRangeSchema, store: appStoreSchema.optional() }),
    output: z.object({ stats: appStoresStatsSchema })
};

/**
 * Toutes les apps visibles sur une même fenêtre. Elle finit au dernier jour
 * commun aux fiches, hormis celles dont les chiffres se sont arrêtés : elles
 * sont nommées dans `left` plutôt que de figer la vue entière.
 */
export const appStoresOverview = {
    command: 'appstores.overview' as const,
    input: z.object({ range: appStoresRangeSchema, store: appStoreSchema.optional() }),
    output: z.object({ overview: appStoresOverviewSchema })
};

/** Gardée par la permission `revenue`, surcharge par app comprise. `store` comme pour `stats`. */
export const appStoresRevenue = {
    command: 'appstores.revenue' as const,
    input: z.object({ appId, range: appStoresRangeSchema, store: appStoreSchema.optional() }),
    output: z.object({ revenue: appStoresRevenueSchema })
};

export const appStoresListReviews = {
    command: 'appstores.listReviews' as const,
    input: z.object({
        appId,
        store: appStoreSchema.optional(),
        rating: z.number().int().min(1).max(5).optional(),
        unanswered: z.boolean().optional(),
        before: appStoresReviewCursorSchema.optional(),
        limit: z.number().int().positive().max(APPSTORES_REVIEW_PAGE_MAX).optional()
    }),
    output: z.object({ reviews: z.array(appStoresReviewSchema), hasMore: z.boolean() })
};

/**
 * Publie une réponse, ou la remplace. L'app se déduit de l'avis, jamais d'un
 * identifiant à part ; la limite du store se vérifie au serveur.
 */
export const appStoresReplyReview = {
    command: 'appstores.replyReview' as const,
    input: z.object({
        reviewId: z.number().int().positive(),
        body: z
            .string()
            .trim()
            .min(1)
            .max(Math.max(APPSTORES_REPLY_MAX_LENGTH.apple, APPSTORES_REPLY_MAX_LENGTH.google))
    }),
    output: z.object({ review: appStoresReviewSchema })
};

export const appStoresCommands = [
    appStoresListSources,
    appStoresAddSource,
    appStoresUpdateSource,
    appStoresRemoveSource,
    appStoresTestSource,
    appStoresListStoreApps,
    appStoresCount,
    appStoresList,
    appStoresGet,
    appStoresAdd,
    appStoresUpdate,
    appStoresRemove,
    appStoresBackfill,
    appStoresStats,
    appStoresOverview,
    appStoresRevenue,
    appStoresListReviews,
    appStoresReplyReview
] as const;
