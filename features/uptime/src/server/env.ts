import { defineModuleEnv, readModuleEnv } from '@deveye/types/sdk/server';

/** Les variables d'environnement de la feature se lisent ici, pas dans `Utils/Env`. */
export const UPTIME_ENV = defineModuleEnv({
    /** La cadence à laquelle le moniteur cherche les services dus. */
    UPTIME_TICK_SECONDS: { kind: 'int', default: 10 },
    /** Combien de sondes partent de front à chaque tour. */
    UPTIME_CONCURRENCY: { kind: 'int', default: 8 },
    /** Le site de DevEye, sur lequel pointe « DevEye » au pied des pages de statut. Vide : pas de lien. */
    UPTIME_SITE_URL: { kind: 'url', default: 'https://deveye.fr' }
});

export const env = readModuleEnv(UPTIME_ENV).values;
