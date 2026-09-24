import { defineModuleEnv, readModuleEnv } from '@deveye/types/sdk/server';

import { DEFAULT_SENTINEL_FINDING_RETENTION_DAYS, DEFAULT_SENTINEL_LEARNING_DAYS } from '../contracts/domain';

/**
 * Les variables d'environnement propres à la feature se lisent ici, pas dans
 * `Utils/Env` de l'app : le module est le seul à savoir ce qu'elles veulent dire.
 */
export const SENTINEL_ENV = defineModuleEnv({
    /**
     * La cadence du moteur est celle à laquelle il vide sa file, et non celle de la
     * collecte : l'ingestion n'évalue rien, elle empile.
     */
    SENTINEL_TICK_SECONDS: { kind: 'int', default: 60 },
    /**
     * Fenêtre d'apprentissage par défaut, en jours : les règles de dérive s'y
     * taisent, sans quoi le premier jour produirait des centaines de constats.
     */
    SENTINEL_LEARNING_DAYS: { kind: 'int', default: DEFAULT_SENTINEL_LEARNING_DAYS },
    /**
     * Un constat est une preuve : il ne suit pas `MONITORING_RETENTION_DAYS`. Seuls
     * les constats résolus s'effacent, bien plus tard, jamais les ouverts.
     */
    SENTINEL_FINDING_RETENTION_DAYS: { kind: 'int', default: DEFAULT_SENTINEL_FINDING_RETENTION_DAYS }
});

export const env = readModuleEnv(SENTINEL_ENV).values;
