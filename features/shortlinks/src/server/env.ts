import { defineModuleEnv, readModuleEnv } from '@deveye/types/sdk/server';

/** Les variables d'environnement de la feature se lisent ici, pas dans `Utils/Env`. */
export const SHORTLINKS_ENV = defineModuleEnv({
    /**
     * Le domaine court de l'instance (`https://dvy.fr`) : les liens y répondent
     * à la racine (`dvy.fr/k3x9p2`), et c'est l'adresse que l'interface donne.
     * Vide : les liens partent de l'adresse publique, sous `/l/`. Un nom à part
     * garde l'adresse de DevEye loin de ce qu'un lien abusif ferait marquer.
     */
    SHORTLINKS_ORIGIN: { kind: 'url', default: '' },
    /**
     * Le port d'un écouteur réservé aux liens (`3002`), où l'exploitant route
     * le domaine court : aucune route des liens ne reste sur les ports de l'app
     * et de la surface publique, et rien d'autre ne répond sur celui-ci. Exige
     * `SHORTLINKS_ORIGIN`. `0` : les liens restent sur la surface publique.
     */
    SHORTLINKS_LISTEN_PORT: { kind: 'int', default: 0, min: 0 }
});

export const env = readModuleEnv(SHORTLINKS_ENV).values;
