import { getEnvVar } from 'dotenv-oxy';

export const env = {
    ENVIRONMENT: getEnvVar('ENVIRONMENT', 'enum', ['dev', 'test', 'prod']),

    LISTEN_PORT: getEnvVar('LISTEN_PORT', 'number'),
    PUBLIC_ORIGIN: getEnvVar('PUBLIC_ORIGIN', 'string'),

    // Origine par laquelle le monde extérieur atteint les routes publiques des
    // modules ; nourrit `ctx.origins.public` (`_sdk/context.ts`), seul lecteur.
    // Distincte de `PUBLIC_ORIGIN` : l'application est derrière le VPN, ces
    // routes doivent être joignables sans lui (sous-domaine dédié exempté côté
    // proxy). Vide, on retombe sur `PUBLIC_ORIGIN` (développement local).
    AUDIENCE_ORIGIN: getEnvVar('AUDIENCE_ORIGIN', 'string', false),

    // Port du second écouteur, celui qu'on expose sur Internet (`publicApp.ts`) :
    // il n'enregistre que les routes publiques des modules. Vide, pas de second
    // serveur, et ces routes restent joignables sur le port principal.
    PUBLIC_LISTEN_PORT: getEnvVar('PUBLIC_LISTEN_PORT', 'number', false),

    LOG_LEVEL: getEnvVar('LOG_LEVEL', 'enum', ['fatal', 'error', 'warn', 'info', 'debug', 'trace']),
    LOG_PATH: getEnvVar('LOG_PATH', 'string', false) || './logs',

    // Racine du stockage CloudSync vue par le serveur (dans le conteneur) ;
    // `CLOUDSYNC_STORAGE_ROOT` est le chemin côté hôte que le compose y monte.
    // Ne change que hors conteneur.
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
    // La vérification des domaines des fonctionnalités : cadence de la passe,
    // puis délai avant de revoir un domaine sain ou un domaine en attente.
    DOMAIN_PROBE_TICK_SECONDS: getEnvVar('DOMAIN_PROBE_TICK_SECONDS', 'number', false) || 300,
    DOMAIN_OK_SECONDS: getEnvVar('DOMAIN_OK_SECONDS', 'number', false) || 60 * 60 * 6,
    DOMAIN_PENDING_SECONDS: getEnvVar('DOMAIN_PENDING_SECONDS', 'number', false) || 600,

    // Les variables propres à un module (SENTINEL_*, MAIL_SYNC_*, OAUTH_*,
    // MONITORING_RETENTION_DAYS, LINK_CODE_TTL_SECONDS) sont lues par le module.

    // Le serveur accepte-t-il les signalements ? Éteint, le bouton disparaît du
    // client, `feedback.submit` refuse et l'administration n'a pas d'entrée.
    // Ce qui est déjà en base y reste, et redevient lisible en rallumant.
    FEEDBACK_ENABLED: getEnvVar('FEEDBACK_ENABLED', 'boolean', false) ?? false,

    COOKIE_DOMAIN: getEnvVar('COOKIE_DOMAIN', 'string', false),

    RATE_LIMIT_MAX: getEnvVar('RATE_LIMIT_MAX', 'number', false) || 200,
    RATE_LIMIT_WINDOW: getEnvVar('RATE_LIMIT_WINDOW', 'string', false) || '1 minute'
};

export const isDev = env.ENVIRONMENT === 'dev';

// Deux écouteurs sur le même port : un `EADDRINUSE` brut après le démarrage du
// serveur principal ne dirait rien de la cause. On refuse tout de suite.
if (env.PUBLIC_LISTEN_PORT && env.PUBLIC_LISTEN_PORT === env.LISTEN_PORT) {
    throw new Error(
        `PUBLIC_LISTEN_PORT (${env.PUBLIC_LISTEN_PORT}) doit différer de LISTEN_PORT : ce sont deux serveurs distincts, ` +
            "et c'est ce qui garde les routes internes hors d'atteinte du domaine public. Laisser PUBLIC_LISTEN_PORT vide " +
            'pour tout servir sur un seul port (cas du développement).'
    );
}
