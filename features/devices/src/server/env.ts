import { DEFAULT_RETENTION_DAYS } from '@deveye/types';
import { defineModuleEnv, readModuleEnv } from '@deveye/types/sdk/server';

/**
 * Les variables d'environnement propres à la feature se lisent ici, pas dans
 * `Utils/Env` de l'app : le module est le seul à savoir ce qu'elles veulent dire.
 */
export const DEVICES_ENV = defineModuleEnv({
    /**
     * Conservation de l'historique (jours) pour les appareils qui n'ont rien
     * choisi. Une seule durée : un relevé est un instant qui porte métriques,
     * présence et processus ensemble.
     */
    MONITORING_RETENTION_DAYS: { kind: 'int', default: DEFAULT_RETENTION_DAYS },
    /** Durée de vie d'un code de liaison (secondes), quand la demande n'en fixe pas. */
    LINK_CODE_TTL_SECONDS: { kind: 'int', default: 60 * 5 }
});

export const env = readModuleEnv(DEVICES_ENV).values;
