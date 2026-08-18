import { databaseAlertFeatures } from './alerts';
import { databaseCrudFeatures } from './crud';
import { databaseExploreFeatures } from './explore';
import { databaseNotificationFeatures } from './notifications';
import { databaseProbeFeatures } from './probe';

/**
 * La feature « Bases de données ».
 *
 * Quatre fichiers, quatre natures :
 *
 *  - `crud.ts` — l'inventaire. Ne joint aucun serveur, lit le cache local.
 *  - `probe.ts` — ce qui va voir sans rien lire du contenu : essai de connexion,
 *    relevé d'état, requête de mise au point. Toujours sur un geste explicite.
 *  - `explore.ts` — les tables : structure, pages, écriture de lignes, terminal,
 *    export. C'est le seul fichier qui nomme des identifiants venus du client,
 *    et donc le seul qui les confronte au catalogue réel.
 *  - `alerts.ts` — les conditions et leur essai à blanc. L'évaluation qui
 *    notifie, elle, appartient à `DatabaseMonitor` : c'est le même chemin pour
 *    un relevé manuel et un relevé automatique.
 *  - `notifications.ts` — **où** partent ces alertes. Cinquième fichier depuis
 *    la migration 085, qui a rendu à la feature les canaux qu'elle empruntait à
 *    Uptime.
 */
export const databaseFeatures = [
    ...databaseCrudFeatures,
    ...databaseProbeFeatures,
    ...databaseExploreFeatures,
    ...databaseAlertFeatures,
    ...databaseNotificationFeatures
];
