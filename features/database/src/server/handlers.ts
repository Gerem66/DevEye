import { databaseAlertFeatures } from './alerts';
import { databaseCrudFeatures } from './crud';
import { databaseExploreFeatures } from './explore';
import { databaseProbeFeatures } from './probe';

/**
 * Les commandes de la feature : `crud.ts` (l'inventaire, cache local),
 * `probe.ts` (essai, relevé, requête de mise au point), `explore.ts` (tables ;
 * le seul qui confronte des identifiants du client au catalogue) et `alerts.ts`
 * (conditions et essai à blanc ; l'évaluation qui notifie vit dans `service.ts`).
 */
export const databaseHandlers = [
    ...databaseCrudFeatures,
    ...databaseProbeFeatures,
    ...databaseExploreFeatures,
    ...databaseAlertFeatures
];
