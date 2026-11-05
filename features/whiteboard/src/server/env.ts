import { defineModuleEnv, readModuleEnv } from '@deveye/types/sdk/server';

/** Les variables d'environnement de la feature se lisent ici, pas dans `Utils/Env`. */
export const WHITEBOARD_ENV = defineModuleEnv({
    /**
     * Où vivent les images collées dans les tableaux tant que le serveur les
     * garde sur son disque. Avec un stockage S3 configuré, ce dossier ne garde
     * que les envois en cours. Dans un conteneur, un volume monté.
     */
    WHITEBOARD_STORAGE_DIR: { kind: 'path', default: '/data/whiteboard' }
});

export const env = readModuleEnv(WHITEBOARD_ENV).values;
