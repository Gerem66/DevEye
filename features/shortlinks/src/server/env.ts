import { defineModuleEnv, readModuleEnv } from '@deveye/types/sdk/server';

/** Les variables d'environnement de la feature se lisent ici, pas dans `Utils/Env`. */
export const SHORTLINKS_ENV = defineModuleEnv({
    /**
     * Le domaine court de l'instance (`https://dvy.fr`) : les liens y répondent
     * à la racine (`dvy.fr/k3x9p2`), et c'est l'adresse que l'interface donne.
     * Vide : les liens partent de l'adresse publique, sous `/l/`. Un nom à part
     * garde l'adresse de DevEye loin de ce qu'un lien abusif ferait marquer.
     */
    SHORTLINKS_ORIGIN: { kind: 'url', default: '' }
});

export const env = readModuleEnv(SHORTLINKS_ENV).values;
