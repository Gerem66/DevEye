import { defineModuleEnv, readModuleEnv } from '@deveye/types/sdk/server';

/** Les variables d'environnement de la feature se lisent ici, pas dans `Utils/Env`. */
export const PROJECTS_ENV = defineModuleEnv({
    /** Le site de DevEye, sur lequel pointe « DevEye » au pied des tableaux publics. Vide : pas de lien. */
    PROJECTS_SITE_URL: { kind: 'url', default: 'https://deveye.fr' }
});

export const env = readModuleEnv(PROJECTS_ENV).values;
