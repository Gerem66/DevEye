import { getEnvVar } from 'dotenv-oxy';
import {
    DEFAULT_RETENTION_DAYS,
    DEFAULT_SENTINEL_FINDING_RETENTION_DAYS,
    DEFAULT_SENTINEL_LEARNING_DAYS
} from 'deveye-types';

export const env = {
    ENVIRONMENT: getEnvVar('ENVIRONMENT', 'enum', ['dev', 'test', 'prod']),

    LISTEN_PORT: getEnvVar('LISTEN_PORT', 'number'),
    PUBLIC_ORIGIN: getEnvVar('PUBLIC_ORIGIN', 'string'),

    // Origine par laquelle les sites suivis atteignent l'ingestion d'audience,
    // et donc celle qui figure dans la balise donnée à copier.
    //
    // **Distincte de `PUBLIC_ORIGIN` par nature** : l'application est derrière
    // le VPN, l'ingestion doit être joignable sans lui. C'est en général un
    // sous-domaine dédié rangé sur le même conteneur (`https://t.exemple.fr`),
    // exempté du filtre côté proxy — exempter un hôte entier se relit d'un coup
    // d'œil, là où un `PathPrefix` mal écrit exposerait toute l'application.
    //
    // Vide, on retombe sur `PUBLIC_ORIGIN` : c'est ce qui fait marcher le
    // développement local sans rien configurer.
    AUDIENCE_ORIGIN: getEnvVar('AUDIENCE_ORIGIN', 'string', false),

    LOG_LEVEL: getEnvVar('LOG_LEVEL', 'enum', ['fatal', 'error', 'warn', 'info', 'debug', 'trace']),
    LOG_PATH: getEnvVar('LOG_PATH', 'string', false) || './logs',

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
    LINK_CODE_TTL_SECONDS: getEnvVar('LINK_CODE_TTL_SECONDS', 'number', false) || 60 * 5,

    // Directory holding the agent binaries served by the download endpoints.
    // On a persistent volume in prod; defaults to `agent/dist` relative to the
    // server's working directory. The boot reconciler syncs binaries here.
    AGENT_DIST_DIR: getEnvVar('AGENT_DIST_DIR', 'string', false),
    // Boot-time agent sync (the ONLY runtime GitHub dependency). Token needs
    // `contents:read`; falls back to GITHUB_PACKAGES_TOKEN. Empty token disables
    // the sync (serves whatever is already on disk — typical dev).
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

    // Conservation de l'historique de supervision (jours), pour les appareils
    // qui n'ont rien choisi. Une seule durée : un relevé est un *instant* qui
    // porte métriques, présence et processus ensemble, et les faire expirer
    // séparément ne produisait que des instants à moitié lisibles.
    MONITORING_RETENTION_DAYS: getEnvVar('MONITORING_RETENTION_DAYS', 'number', false) || DEFAULT_RETENTION_DAYS,

    // Sentinelle. La cadence du moteur est celle à laquelle il vide sa file, et
    // non celle de la collecte : l'ingestion n'évalue rien, elle empile.
    SENTINEL_TICK_SECONDS: getEnvVar('SENTINEL_TICK_SECONDS', 'number', false) || 60,
    // Fenêtre d'apprentissage par défaut, en jours. Pendant qu'elle court, les
    // règles de dérive se taisent — sans quoi le premier jour produirait des
    // centaines de « nouveau programme ».
    SENTINEL_LEARNING_DAYS: getEnvVar('SENTINEL_LEARNING_DAYS', 'number', false) || DEFAULT_SENTINEL_LEARNING_DAYS,
    // Un constat est une **preuve** : il ne suit pas `MONITORING_RETENTION_DAYS`.
    // Seuls les constats résolus s'effacent, et bien plus tard ; les ouverts ne
    // s'effacent jamais.
    SENTINEL_FINDING_RETENTION_DAYS:
        getEnvVar('SENTINEL_FINDING_RETENTION_DAYS', 'number', false) || DEFAULT_SENTINEL_FINDING_RETENTION_DAYS,

    // Uptime scheduler: how often the server looks for services due for a probe,
    // and how many it may probe at once.
    UPTIME_TICK_SECONDS: getEnvVar('UPTIME_TICK_SECONDS', 'number', false) || 10,
    UPTIME_CONCURRENCY: getEnvVar('UPTIME_CONCURRENCY', 'number', false) || 8,

    // Mail background sync: same shape as Uptime, but only ever touches "open"
    // tier accounts (guarded accounts sync on demand during a live session).
    MAIL_SYNC_TICK_SECONDS: getEnvVar('MAIL_SYNC_TICK_SECONDS', 'number', false) || 120,
    MAIL_SYNC_CONCURRENCY: getEnvVar('MAIL_SYNC_CONCURRENCY', 'number', false) || 4,
    // Échéance au-delà de laquelle la relève d'un compte est abandonnée. Large,
    // parce qu'une première synchro parcourt tous les dossiers d'une boîte : elle
    // n'est pas là pour presser le travail, mais pour qu'un compte dont la
    // connexion reste suspendue ne se retrouve pas retiré de la rotation pour
    // toujours, sans erreur ni trace, jusqu'au prochain redémarrage.
    MAIL_SYNC_ACCOUNT_TIMEOUT_SECONDS: getEnvVar('MAIL_SYNC_ACCOUNT_TIMEOUT_SECONDS', 'number', false) || 900,

    // Mail OAuth (Gmail/Microsoft 365). Entirely optional per provider: with no
    // client id/secret configured, that provider's "Connect with..." option is
    // simply hidden — password/app-password auth still works regardless. The
    // self-hosting admin registers their own OAuth app (Google Cloud Console /
    // Azure Portal) with a redirect URI of `${PUBLIC_ORIGIN}/api/mail/oauth/callback`.
    OAUTH_GOOGLE_CLIENT_ID: getEnvVar('OAUTH_GOOGLE_CLIENT_ID', 'string', false),
    OAUTH_GOOGLE_CLIENT_SECRET: getEnvVar('OAUTH_GOOGLE_CLIENT_SECRET', 'string', false),
    OAUTH_MICROSOFT_CLIENT_ID: getEnvVar('OAUTH_MICROSOFT_CLIENT_ID', 'string', false),
    OAUTH_MICROSOFT_CLIENT_SECRET: getEnvVar('OAUTH_MICROSOFT_CLIENT_SECRET', 'string', false),

    COOKIE_DOMAIN: getEnvVar('COOKIE_DOMAIN', 'string', false),

    RATE_LIMIT_MAX: getEnvVar('RATE_LIMIT_MAX', 'number', false) || 200,
    RATE_LIMIT_WINDOW: getEnvVar('RATE_LIMIT_WINDOW', 'string', false) || '1 minute'
};

export const isDev = env.ENVIRONMENT === 'dev';
