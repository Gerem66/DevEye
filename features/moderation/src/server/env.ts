import { defineModuleEnv, readModuleEnv } from '@deveye/types/sdk/server';

/**
 * Les réglages d'environnement du module, lus une fois. L'hôte relit cette spec
 * au démarrage et nomme celles qui sont restées à leur défaut.
 */
export const MODERATION_ENV = defineModuleEnv({
    /**
     * Une liste externe d'empreintes SHA-256 (une par ligne, les lignes en `#`
     * ignorées), relue toutes les heures et versée dans les règles. Vide : pas
     * de liste, les règles viennent de la saisie, des retraits et des imports.
     */
    MODERATION_FEED_URL: { kind: 'url', default: '' },
    /** La clé que la liste externe attend dans l'en-tête `Auth-Key`, si elle en attend une. */
    MODERATION_FEED_AUTH_KEY: { kind: 'secret' }
});

export const env = readModuleEnv(MODERATION_ENV).values;
