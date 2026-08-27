import { DEFAULT_SENTINEL_FINDING_RETENTION_DAYS, DEFAULT_SENTINEL_LEARNING_DAYS } from '../contracts/domain';

/**
 * Les variables d'environnement propres à la feature se lisent ici, pas dans
 * `Utils/Env` de l'app : depuis le rapatriement, le module est seul à les
 * connaître, et `.env.template` les documente comme lues par lui.
 */

/**
 * Sentinelle. La cadence du moteur est celle à laquelle il vide sa file, et
 * non celle de la collecte : l'ingestion n'évalue rien, elle empile.
 */
export const TICK_SECONDS = Number(process.env.SENTINEL_TICK_SECONDS) || 60;

/**
 * Fenêtre d'apprentissage par défaut, en jours. Pendant qu'elle court, les
 * règles de dérive se taisent, sans quoi le premier jour produirait des
 * centaines de « nouveau programme ».
 */
export const LEARNING_DAYS = Number(process.env.SENTINEL_LEARNING_DAYS) || DEFAULT_SENTINEL_LEARNING_DAYS;

/**
 * Un constat est une **preuve** : il ne suit pas `MONITORING_RETENTION_DAYS`.
 * Seuls les constats résolus s'effacent, et bien plus tard ; les ouverts ne
 * s'effacent jamais.
 */
export const FINDING_RETENTION_DAYS =
    Number(process.env.SENTINEL_FINDING_RETENTION_DAYS) || DEFAULT_SENTINEL_FINDING_RETENTION_DAYS;
