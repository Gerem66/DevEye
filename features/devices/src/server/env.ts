import { DEFAULT_RETENTION_DAYS } from '@deveye/types';

/**
 * Les variables d'environnement propres à la feature se lisent ici, pas dans
 * `Utils/Env` de l'app : le module est le seul à savoir ce qu'elles veulent
 * dire. Même modèle que `features/mail/src/server/env.ts` ; les défauts sont
 * ceux que l'app appliquait quand Appareils était native.
 */
export const env = {
    /**
     * Conservation de l'historique de supervision (jours), pour les appareils
     * qui n'ont rien choisi (`devices.retention_days` à NULL). Une seule
     * durée : un relevé est un *instant* qui porte métriques, présence et
     * processus ensemble, et les faire expirer séparément ne produisait que
     * des instants à moitié lisibles.
     */
    MONITORING_RETENTION_DAYS: Number(process.env.MONITORING_RETENTION_DAYS) || DEFAULT_RETENTION_DAYS,
    /** Durée de vie d'un code de liaison (secondes), quand la demande n'en fixe pas. */
    LINK_CODE_TTL_SECONDS: Number(process.env.LINK_CODE_TTL_SECONDS) || 60 * 5
};
