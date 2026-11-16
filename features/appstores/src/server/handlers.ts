import { appStoresAppFeatures } from './apps';
import { appStoresReviewFeatures } from './reviews';
import { appStoresSourceFeatures } from './sources';
import { appStoresStatsFeatures } from './stats';

/**
 * Les commandes de Stores : les comptes de store (`sources.ts`), les apps
 * (`apps.ts`), leurs chiffres (`stats.ts`) et leurs avis (`reviews.ts`).
 */
export const appStoresHandlers = [
    ...appStoresSourceFeatures,
    ...appStoresAppFeatures,
    ...appStoresStatsFeatures,
    ...appStoresReviewFeatures
];
