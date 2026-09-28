import { defineModuleEnv, readModuleEnv } from '@deveye/types/sdk/server';

/** Les variables d'environnement de la feature se lisent ici, pas dans `Utils/Env`. */
export const UPTIME_ENV = defineModuleEnv({
    /** La cadence à laquelle le moniteur cherche les services dus. */
    UPTIME_TICK_SECONDS: { kind: 'int', default: 10 },
    /** Combien de sondes sont en vol à la fois. Une sonde attend le réseau, pas le processeur. */
    UPTIME_CONCURRENCY: { kind: 'int', default: 16 }
});

export const env = readModuleEnv(UPTIME_ENV).values;
