import { defineModuleEnv, readModuleEnv } from '@deveye/types/sdk/server';

/**
 * Même paire hôte/conteneur que CloudSync : `BACKUP_STORAGE_ROOT` est le
 * dossier de l'hôte (docker compose), `BACKUP_STORAGE_DIR` ce dossier vu par
 * le serveur.
 */
export const BACKUP_ENV = defineModuleEnv({
    /**
     * La racine des destinations `local`, cloisonnée par espace en dessous. Avec
     * un bucket configuré (`STORAGE_S3_*`), les archives y partent et ce dossier
     * ne garde que le spool.
     */
    BACKUP_STORAGE_DIR: { kind: 'path', default: '/data/backups' },
    /** La cadence de l'ordonnanceur : à quelle fréquence il cherche les travaux dus. */
    BACKUP_TICK_SECONDS: { kind: 'int', default: 60 },
    /**
     * Le budget d'une exécution. Sans lui, un agent qui cesse de répondre au
     * milieu d'un dépôt laisserait le travail « en cours » pour toujours.
     */
    BACKUP_RUN_TIMEOUT_SECONDS: { kind: 'int', default: 6 * 60 * 60 }
});

export const env = {
    ...readModuleEnv(BACKUP_ENV).values,
    /**
     * La base de DevEye elle-même, pour la source `deveye`. Hors de la spec :
     * ce sont les variables du socle, qui les exige avant de démarrer.
     */
    DB_HOSTNAME: process.env.DB_HOSTNAME ?? '',
    DB_PORT: Number(process.env.DB_PORT) || 3306,
    DB_DATABASE: process.env.DB_DATABASE ?? '',
    DB_USERNAME: process.env.DB_USERNAME ?? '',
    DB_PASSWORD: process.env.DB_PASSWORD ?? ''
};
