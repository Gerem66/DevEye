import { getEnvVar } from 'dotenv-oxy';

export const env = {
    ENVIRONMENT: getEnvVar('ENVIRONMENT', 'enum', ['dev', 'test', 'prod']),

    LISTEN_PORT: getEnvVar('LISTEN_PORT', 'number'),
    PUBLIC_ORIGIN: getEnvVar('PUBLIC_ORIGIN', 'string'),

    // Origine de l'écouteur **public** : celle par laquelle le monde extérieur
    // atteint les routes publiques des modules, donc celle qui figure dans ce
    // qu'un module donne à copier (la balise d'audience). Elle nourrit
    // `ctx.origins.public` de TOUS les modules (`_sdk/context.ts`) ; aucun ne
    // la lit directement, et l'app non plus.
    //
    // **Distincte de `PUBLIC_ORIGIN` par nature** : l'application est derrière
    // le VPN, l'ingestion doit être joignable sans lui. C'est en général un
    // sous-domaine dédié rangé sur le même conteneur (`https://t.exemple.fr`),
    // exempté du filtre côté proxy, exempter un hôte entier se relisant d'un
    // coup d'œil, là où un `PathPrefix` mal écrit exposerait toute l'application.
    //
    // Vide, on retombe sur `PUBLIC_ORIGIN` : c'est ce qui fait marcher le
    // développement local sans rien configurer. Le nom garde son histoire
    // (Audience a été la première, et reste la seule, à ouvrir une porte).
    AUDIENCE_ORIGIN: getEnvVar('AUDIENCE_ORIGIN', 'string', false),

    /**
     * Port du **second écouteur**, celui qu'on expose sur Internet.
     *
     * Vide, il n'y en a pas : le serveur se comporte exactement comme avant, et
     * les routes publiques restent joignables sur le port principal. C'est le
     * cas du développement, où un seul port sert tout.
     *
     * Réglé, un second serveur démarre, qui **n'enregistre que** les routes
     * publiques des modules (capacité `routes.public` : l'ingestion d'audience
     * et son script, voir `publicApp.ts`). On lui dédie alors un domaine côté
     * proxy, et il n'existe aucun chemin de code de ce port vers
     * l'authentification, la socket ou le client web.
     */
    PUBLIC_LISTEN_PORT: getEnvVar('PUBLIC_LISTEN_PORT', 'number', false),

    LOG_LEVEL: getEnvVar('LOG_LEVEL', 'enum', ['fatal', 'error', 'warn', 'info', 'debug', 'trace']),
    LOG_PATH: getEnvVar('LOG_PATH', 'string', false) || './logs',

    /**
     * Racine du stockage CloudSync **vue par le serveur**, c'est-à-dire dans le
     * conteneur. Le compose y monte un volume dont la source, sur l'hôte, est
     * `CLOUDSYNC_STORAGE_ROOT` — deux variables distinctes parce que ce sont
     * deux chemins différents, et les confondre menait à écrire à l'intérieur
     * du conteneur (donc à perdre les données au redéploiement).
     *
     * On n'y touche que pour un déploiement hors conteneur, où les deux côtés
     * se confondent effectivement. Voir `Docs/CLOUDSYNC.md`.
     */
    CLOUDSYNC_STORAGE_DIR: getEnvVar('CLOUDSYNC_STORAGE_DIR', 'string', false) || '/data/cloudsync',

    SSL_PRIVATE_KEY_PATH: getEnvVar('SSL_PRIVATE_KEY_PATH', 'string', false),
    SSL_CERTIFICATE_PATH: getEnvVar('SSL_CERTIFICATE_PATH', 'string', false),

    // MySQL database
    DB_HOSTNAME: getEnvVar('DB_HOSTNAME', 'string'),
    DB_PORT: getEnvVar('DB_PORT', 'number', false) || 3306,
    DB_DATABASE: getEnvVar('DB_DATABASE', 'string'),
    DB_USERNAME: getEnvVar('DB_USERNAME', 'string'),
    DB_PASSWORD: getEnvVar('DB_PASSWORD', 'string'),
    DB_POOL_MAX: getEnvVar('DB_POOL_MAX', 'number', false) || 10,

    // Symmetric encryption used by feature payloads (passwords, etc.)
    CRYPT_KEY_A: getEnvVar('CRYPT_KEY_A', 'string'),
    CRYPT_KEY_B: getEnvVar('CRYPT_KEY_B', 'string'),

    // Auth (JWT + refresh). Use base64url-encoded random secrets, >= 32 bytes.
    JWT_ACCESS_SECRET: getEnvVar('JWT_ACCESS_SECRET', 'string'),
    JWT_REFRESH_SECRET: getEnvVar('JWT_REFRESH_SECRET', 'string'),
    JWT_ACCESS_TTL_SECONDS: getEnvVar('JWT_ACCESS_TTL_SECONDS', 'number', false) || 60 * 15,
    JWT_REFRESH_TTL_SECONDS: getEnvVar('JWT_REFRESH_TTL_SECONDS', 'number', false) || 60 * 60 * 24 * 30,

    // Device (agent) tokens — long-lived, signed with a dedicated secret.
    DEVICE_TOKEN_SECRET: getEnvVar('DEVICE_TOKEN_SECRET', 'string'),

    // Directory holding the agent binaries served by the download endpoints.
    // On a persistent volume in prod; defaults to `agent/dist` relative to the
    // server's working directory. The boot reconciler syncs binaries here.
    AGENT_DIST_DIR: getEnvVar('AGENT_DIST_DIR', 'string', false),
    // Boot-time agent sync (the ONLY runtime GitHub dependency). Token needs
    // `contents:read`. Empty token disables the sync (serves whatever is
    // already on disk — typical dev).
    AGENT_DOWNLOAD_TOKEN: getEnvVar('AGENT_DOWNLOAD_TOKEN', 'string', false),
    AGENT_RELEASE_TAG: getEnvVar('AGENT_RELEASE_TAG', 'string', false),
    AGENT_REPO: getEnvVar('AGENT_REPO', 'string', false),
    // How long the boot reconcile waits for THIS deploy's agent build to publish
    // before it stops the loader and surfaces a verdict (served older set ⇒ warning,
    // nothing ⇒ error). Lower = a failed build is flagged faster; too low risks
    // flagging a build that's merely slow. Raise it above your agent build time.
    AGENT_SYNC_TIMEOUT_SECONDS: getEnvVar('AGENT_SYNC_TIMEOUT_SECONDS', 'number', false) || 300,

    // Interim 2FA challenge token (between password check and TOTP verify).
    TWOFA_ISSUER: getEnvVar('TWOFA_ISSUER', 'string', false) || 'DevEye',
    TWOFA_CHALLENGE_TTL_SECONDS: getEnvVar('TWOFA_CHALLENGE_TTL_SECONDS', 'number', false) || 60 * 5,

    // (Les SENTINEL_* sont lues par le module Sentinelle lui-même, features/sentinel ;
    // les MAIL_SYNC_* et OAUTH_* par le module Mail, features/mail ;
    // MONITORING_RETENTION_DAYS et LINK_CODE_TTL_SECONDS par le module
    // Appareils, features/devices.)

    COOKIE_DOMAIN: getEnvVar('COOKIE_DOMAIN', 'string', false),

    RATE_LIMIT_MAX: getEnvVar('RATE_LIMIT_MAX', 'number', false) || 200,
    RATE_LIMIT_WINDOW: getEnvVar('RATE_LIMIT_WINDOW', 'string', false) || '1 minute'
};

export const isDev = env.ENVIRONMENT === 'dev';

// Les deux écouteurs sur le même port, c'est un `EADDRINUSE` brut au démarrage,
// et **après** que le serveur principal soit debout : le message ne dirait rien
// de la cause. On refuse tout de suite, en la nommant.
if (env.PUBLIC_LISTEN_PORT && env.PUBLIC_LISTEN_PORT === env.LISTEN_PORT) {
    throw new Error(
        `PUBLIC_LISTEN_PORT (${env.PUBLIC_LISTEN_PORT}) doit différer de LISTEN_PORT : ce sont deux serveurs distincts, ` +
            "et c'est ce qui garde les routes internes hors d'atteinte du domaine public. Laisser PUBLIC_LISTEN_PORT vide " +
            'pour tout servir sur un seul port (cas du développement).'
    );
}
