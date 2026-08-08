import { databaseAlertFeatures } from './alerts';
import { databaseCrudFeatures } from './crud';
import { databaseProbeFeatures } from './probe';

/**
 * La feature « Bases de données ».
 *
 * Trois fichiers, trois natures :
 *
 *  - `crud.ts` — l'inventaire. Ne joint aucun serveur, lit le cache local.
 *  - `probe.ts` — ce qui va voir : test, relevé, tables, requête. Toujours sur
 *    un geste explicite, jamais à l'ouverture d'un écran.
 *  - `alerts.ts` — les conditions et leur essai à blanc. L'évaluation qui
 *    notifie, elle, appartient à `DatabaseMonitor` : c'est le même chemin pour
 *    un relevé manuel et un relevé automatique.
 */
export const databaseFeatures = [...databaseCrudFeatures, ...databaseProbeFeatures, ...databaseAlertFeatures];
