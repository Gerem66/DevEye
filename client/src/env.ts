/**
 * Ce que Vite pose à la construction. Hors de Vite (les tests sous Node),
 * `import.meta.env` n'existe pas : chaque valeur prend alors celle d'un client
 * construit pour la production et servi par son propre serveur.
 */
const env: Partial<ImportMetaEnv> = (import.meta as { env?: ImportMetaEnv }).env ?? {};

/** L'origine du serveur quand ce n'est pas celle de la page, vide sinon. */
export const SERVER_URL: string = env.VITE_SERVER_URL ?? '';

/** Sous le serveur de développement de Vite. */
export const DEV: boolean = env.DEV ?? false;

export const ENV_NAME: ImportMetaEnv['VITE_ENV'] | undefined = env.VITE_ENV;
