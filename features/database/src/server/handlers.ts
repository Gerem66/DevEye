import { databaseAlertFeatures } from './alerts';
import { databaseCrudFeatures } from './crud';
import { databaseExploreFeatures } from './explore';
import { databaseProbeFeatures } from './probe';

/**
 * Les commandes de la feature « Bases de données ».
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
 *    notifie, elle, appartient à `DatabaseMonitor` (`service.ts`) : c'est le
 *    même chemin pour un relevé manuel et un relevé automatique.
 *
 * **Où** partent ces alertes ne se règle plus ici : depuis la migration 085,
 * qui a rendu à la feature les canaux qu'elle empruntait à Uptime, les canaux
 * sont ceux de la coquille commune (Réglages → Notifications, à l'échelle de
 * la feature et de chaque base), et le module notifie par la façade `notify`
 * du SDK.
 */
export const databaseHandlers = [
    ...databaseCrudFeatures,
    ...databaseProbeFeatures,
    ...databaseExploreFeatures,
    ...databaseAlertFeatures
];
