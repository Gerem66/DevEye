/**
 * Les variables d'environnement propres à la feature se lisent ici, pas dans
 * `Utils/Env` de l'app : le module est le seul à savoir ce qu'elles veulent
 * dire. Même modèle que `features/backup/src/server/env.ts` ; les défauts sont
 * ceux que l'app appliquait quand Mail était native.
 */
export const env = {
    /**
     * La cadence de la relève de fond : à quelle fréquence le service cherche
     * les boîtes ouvertes dues. Même principe que l'ordonnanceur d'Uptime,
     * mais ne touche jamais les comptes gardés (synchronisés uniquement à la
     * demande pendant une session déverrouillée).
     */
    MAIL_SYNC_TICK_SECONDS: Number(process.env.MAIL_SYNC_TICK_SECONDS) || 120,
    /** Combien de boîtes se relèvent de front à chaque tour. */
    MAIL_SYNC_CONCURRENCY: Number(process.env.MAIL_SYNC_CONCURRENCY) || 4,
    /**
     * Échéance au-delà de laquelle la relève d'un compte est abandonnée. Large,
     * parce qu'une première synchro parcourt tous les dossiers d'une boîte : elle
     * n'est pas là pour presser le travail, mais pour qu'un compte dont la
     * connexion reste suspendue ne se retrouve pas retiré de la rotation pour
     * toujours, sans erreur ni trace, jusqu'au prochain redémarrage.
     */
    MAIL_SYNC_ACCOUNT_TIMEOUT_SECONDS: Number(process.env.MAIL_SYNC_ACCOUNT_TIMEOUT_SECONDS) || 900,

    /**
     * OAuth (Gmail / Microsoft 365). Entièrement optionnel par fournisseur :
     * sans client id et secret, l'option « Se connecter avec... » de ce
     * fournisseur est simplement masquée, l'authentification par mot de passe
     * (ou mot de passe d'application) marche toujours. L'administrateur
     * enregistre sa propre app OAuth (Google Cloud Console / Azure Portal)
     * avec pour URI de redirection `${PUBLIC_ORIGIN}/api/mail/oauth/callback`
     * (l'origine de l'app, `ctx.origins.app`).
     */
    OAUTH_GOOGLE_CLIENT_ID: process.env.OAUTH_GOOGLE_CLIENT_ID || undefined,
    OAUTH_GOOGLE_CLIENT_SECRET: process.env.OAUTH_GOOGLE_CLIENT_SECRET || undefined,
    OAUTH_MICROSOFT_CLIENT_ID: process.env.OAUTH_MICROSOFT_CLIENT_ID || undefined,
    OAUTH_MICROSOFT_CLIENT_SECRET: process.env.OAUTH_MICROSOFT_CLIENT_SECRET || undefined
};
