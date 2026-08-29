/**
 * Les variables d'environnement propres à la feature se lisent ici, pas dans
 * `Utils/Env` de l'app : le module est le seul à savoir ce qu'elles veulent dire.
 */
export const env = {
    /**
     * La cadence de la relève de fond, qui ne touche jamais les comptes gardés
     * (synchronisés à la demande, pendant une session déverrouillée).
     */
    MAIL_SYNC_TICK_SECONDS: Number(process.env.MAIL_SYNC_TICK_SECONDS) || 120,
    /** Combien de boîtes se relèvent de front à chaque tour. */
    MAIL_SYNC_CONCURRENCY: Number(process.env.MAIL_SYNC_CONCURRENCY) || 4,
    /**
     * Échéance au-delà de laquelle la relève d'un compte est abandonnée. Large,
     * parce qu'une première synchro parcourt tous les dossiers d'une boîte : elle
     * n'est là que pour qu'un compte dont la connexion reste suspendue ne sorte
     * pas de la rotation pour toujours.
     */
    MAIL_SYNC_ACCOUNT_TIMEOUT_SECONDS: Number(process.env.MAIL_SYNC_ACCOUNT_TIMEOUT_SECONDS) || 900,

    /**
     * OAuth (Gmail / Microsoft 365), optionnel par fournisseur : sans client id
     * ni secret, l'option « Se connecter avec... » du fournisseur est masquée et
     * l'authentification par mot de passe marche toujours. L'administrateur
     * enregistre sa propre app OAuth avec pour URI de redirection
     * `${PUBLIC_ORIGIN}/api/mail/oauth/callback`.
     */
    OAUTH_GOOGLE_CLIENT_ID: process.env.OAUTH_GOOGLE_CLIENT_ID || undefined,
    OAUTH_GOOGLE_CLIENT_SECRET: process.env.OAUTH_GOOGLE_CLIENT_SECRET || undefined,
    OAUTH_MICROSOFT_CLIENT_ID: process.env.OAUTH_MICROSOFT_CLIENT_ID || undefined,
    OAUTH_MICROSOFT_CLIENT_SECRET: process.env.OAUTH_MICROSOFT_CLIENT_SECRET || undefined
};
