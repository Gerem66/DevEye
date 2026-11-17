import { appStoresAppFeatures } from './apps';
import { appStoresOverviewFeatures } from './overview';
import { appStoresReviewFeatures } from './reviews';
import { appStoresSourceFeatures } from './sources';
import { appStoresStatsFeatures } from './stats';

/**
 * Les commandes de Stores : les comptes de store (`sources.ts`), les apps
 * (`apps.ts`), leurs chiffres (`stats.ts`), la vue de toutes à la fois
 * (`overview.ts`) et leurs avis (`reviews.ts`).
 */
export const appStoresHandlers = [
    ...appStoresSourceFeatures,
    ...appStoresAppFeatures,
    ...appStoresStatsFeatures,
    ...appStoresOverviewFeatures,
    ...appStoresReviewFeatures
];
