/**
 * Les variables d'environnement propres à la feature se lisent ici, pas dans
 * `Utils/Env` de l'app : le module est le seul à savoir ce qu'elles veulent
 * dire. Même paire hôte/conteneur que CloudSync pour le stockage :
 * `BACKUP_STORAGE_ROOT` est le dossier de l'hôte (lu par docker compose seul,
 * source du montage), `BACKUP_STORAGE_DIR` ce même dossier vu par le serveur.
 */
export const env = {
    /** La racine des destinations `local`, cloisonnée par espace en dessous. */
    BACKUP_STORAGE_DIR: process.env.BACKUP_STORAGE_DIR || '/data/backups',
    /** La cadence de l'ordonnanceur : à quelle fréquence il cherche les travaux dus. */
    BACKUP_TICK_SECONDS: Number(process.env.BACKUP_TICK_SECONDS) || 60,
    /**
     * Le budget d'une exécution. Sans lui, un agent qui cesse de répondre au
     * milieu d'un dépôt laisserait le travail « en cours » pour toujours.
     */
    BACKUP_RUN_TIMEOUT_SECONDS: Number(process.env.BACKUP_RUN_TIMEOUT_SECONDS) || 6 * 60 * 60,
    /**
     * La base de DevEye elle-même, pour la source `deveye` : les mêmes
     * variables que celles avec lesquelles ce processus s'est connecté. Lues
     * telles quelles ; l'app a déjà refusé de démarrer si elles manquaient.
     */
    DB_HOSTNAME: process.env.DB_HOSTNAME ?? '',
    DB_PORT: Number(process.env.DB_PORT) || 3306,
    DB_DATABASE: process.env.DB_DATABASE ?? '',
    DB_USERNAME: process.env.DB_USERNAME ?? '',
    DB_PASSWORD: process.env.DB_PASSWORD ?? ''
};
