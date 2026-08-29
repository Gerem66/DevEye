import { DEFAULT_SENTINEL_FINDING_RETENTION_DAYS, DEFAULT_SENTINEL_LEARNING_DAYS } from '../contracts/domain';

/**
 * Les variables d'environnement propres à la feature se lisent ici, pas dans
 * `Utils/Env` de l'app : le module est le seul à savoir ce qu'elles veulent dire.
 */

/**
 * La cadence du moteur est celle à laquelle il vide sa file, et non celle de la
 * collecte : l'ingestion n'évalue rien, elle empile.
 */
export const TICK_SECONDS = Number(process.env.SENTINEL_TICK_SECONDS) || 60;

/**
 * Fenêtre d'apprentissage par défaut, en jours : les règles de dérive s'y
 * taisent, sans quoi le premier jour produirait des centaines de constats.
 */
export const LEARNING_DAYS = Number(process.env.SENTINEL_LEARNING_DAYS) || DEFAULT_SENTINEL_LEARNING_DAYS;

/**
 * Un constat est une preuve : il ne suit pas `MONITORING_RETENTION_DAYS`. Seuls
 * les constats résolus s'effacent, bien plus tard, jamais les ouverts.
 */
export const FINDING_RETENTION_DAYS =
    Number(process.env.SENTINEL_FINDING_RETENTION_DAYS) || DEFAULT_SENTINEL_FINDING_RETENTION_DAYS;
