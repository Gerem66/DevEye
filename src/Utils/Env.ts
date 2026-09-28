import { getEnvVar } from 'dotenv-oxy';

export const env = {
    ENVIRONMENT: getEnvVar('ENVIRONMENT', 'enum', ['dev', 'test', 'prod']),

    LISTEN_PORT: getEnvVar('LISTEN_PORT', 'number'),
    PUBLIC_ORIGIN: getEnvVar('PUBLIC_ORIGIN', 'string'),

    // Origine par laquelle le monde extérieur atteint les routes publiques des
    // modules ; nourrit `ctx.origins.public` (`_sdk/context.ts`), seul lecteur.
    // Distincte de `PUBLIC_ORIGIN` quand ces routes ont leur propre domaine,
    // pointé sur `PUBLIC_LISTEN_PORT` : l'application peut alors rester privée
    // et n'exposer qu'elles. Vide, on retombe sur `PUBLIC_ORIGIN`.
    AUDIENCE_ORIGIN: getEnvVar('AUDIENCE_ORIGIN', 'string', false),

    // Le site vitrine, où vivent les pages légales (`/cgu`, `/cgv`,
    // `/confidentialite`, `/mentions-legales`) : l'inscription les fait
    // accepter et l'app y renvoie. Vide (auto-hébergé) : ni case, ni liens.
    SITE_URL: getEnvVar('SITE_URL', 'string', false),

    // Port du second écouteur, celui qu'on expose sur Internet (`publicApp.ts`) :
    // il n'enregistre que les routes publiques des modules. Vide, pas de second
    // serveur, et ces routes restent joignables sur le port principal.
    PUBLIC_LISTEN_PORT: getEnvVar('PUBLIC_LISTEN_PORT', 'number', false),

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

    // Clé serveur : deux chaînes aléatoires distinctes, combinées par HKDF
    // (`Services/Encryption.ts`). Longueur vérifiée au boot, plus bas.
    CRYPT_KEY_A: getEnvVar('CRYPT_KEY_A', 'string'),
    CRYPT_KEY_B: getEnvVar('CRYPT_KEY_B', 'string'),

    // Auth (JWT + refresh). Use base64url-encoded random secrets, >= 32 bytes.
    JWT_ACCESS_SECRET: getEnvVar('JWT_ACCESS_SECRET', 'string'),
    JWT_REFRESH_SECRET: getEnvVar('JWT_REFRESH_SECRET', 'string'),
    JWT_ACCESS_TTL_SECONDS: getEnvVar('JWT_ACCESS_TTL_SECONDS', 'number', false) || 60 * 15,
    JWT_REFRESH_TTL_SECONDS: getEnvVar('JWT_REFRESH_TTL_SECONDS', 'number', false) || 60 * 60 * 24 * 30,

    // Device (agent) tokens, signed with a dedicated secret.
    DEVICE_TOKEN_SECRET: getEnvVar('DEVICE_TOKEN_SECRET', 'string'),
    // La graine Ed25519 (32 octets, base64) qui signe les ordres à fort impact
    // envoyés aux agents (`agent/orders.ts`). La changer oblige à réappairer
    // chaque machine : elles épinglent la clé publique à l'enrôlement.
    ORDER_SIGNING_KEY: getEnvVar('ORDER_SIGNING_KEY', 'string'),

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
    // Le proxy qui sert les domaines des clients (Traefik) lit leur liste ici,
    // et obtient seul leur certificat (`Services/domains/proxy.ts`). Sans jeton,
    // c'est à l'administrateur d'ajouter chaque nom au proxy. L'amont est
    // l'écouteur public tel que le proxy le joint : `http://deveye-server:3001`.
    DOMAIN_PROXY_TOKEN: getEnvVar('DOMAIN_PROXY_TOKEN', 'string', false),
    DOMAIN_PROXY_UPSTREAM: getEnvVar('DOMAIN_PROXY_UPSTREAM', 'string', false),
    DOMAIN_PROXY_CERT_RESOLVER: getEnvVar('DOMAIN_PROXY_CERT_RESOLVER', 'string', false) || 'letsencrypt',
    DOMAIN_PROXY_ENTRYPOINT: getEnvVar('DOMAIN_PROXY_ENTRYPOINT', 'string', false) || 'websecure',

    // Le stockage objet des fichiers que les modules gardent pour leurs membres
    // (partages CloudSync, sauvegardes « sur le serveur ») : un bucket S3 au lieu
    // du disque (`Services/objectStorage`). Vide, chaque module écrit sous son
    // dossier local. L'adresse vient de l'opérateur, pas d'un membre : un S3 du
    // réseau privé (MinIO, Garage) est joignable sans OUTBOUND_ALLOW_PRIVATE.
    STORAGE_S3_ENDPOINT: getEnvVar('STORAGE_S3_ENDPOINT', 'string', false),
    STORAGE_S3_REGION: getEnvVar('STORAGE_S3_REGION', 'string', false),
    STORAGE_S3_BUCKET: getEnvVar('STORAGE_S3_BUCKET', 'string', false),
    STORAGE_S3_ACCESS_KEY_ID: getEnvVar('STORAGE_S3_ACCESS_KEY_ID', 'string', false),
    STORAGE_S3_SECRET_ACCESS_KEY: getEnvVar('STORAGE_S3_SECRET_ACCESS_KEY', 'string', false),
    // `https://hôte/bucket/clé` (MinIO, Garage) plutôt que `https://bucket.hôte/clé`.
    STORAGE_S3_PATH_STYLE: getEnvVar('STORAGE_S3_PATH_STYLE', 'boolean', false) ?? false,
    // Pour loger plusieurs instances dans un même bucket : `prod`, `demo`.
    STORAGE_S3_PREFIX: getEnvVar('STORAGE_S3_PREFIX', 'string', false),

    // Les variables propres à un module (SENTINEL_*, MAIL_SYNC_*, OAUTH_*,
    // MONITORING_RETENTION_DAYS, LINK_CODE_TTL_SECONDS) sont lues par le module.

    // Le serveur accepte-t-il les signalements ? Éteint, le bouton disparaît du
    // client, `feedback.submit` refuse et l'administration n'a pas d'entrée.
    // Ce qui est déjà en base y reste, et redevient lisible en rallumant.
    FEEDBACK_ENABLED: getEnvVar('FEEDBACK_ENABLED', 'boolean', false) ?? false,

    // Démarrer le site en maintenance (voir `Services/maintenance.ts`), que
    // l'interface lèvera ensuite : un point de départ, pas un verrou.
    MAINTENANCE: getEnvVar('MAINTENANCE', 'boolean', false) ?? false,

    COOKIE_DOMAIN: getEnvVar('COOKIE_DOMAIN', 'string', false),

    // Les origines dont la page peut ouvrir une session ici depuis un navigateur :
    // une autre instance DevEye qui range celle-ci parmi ses instances distantes.
    // Séparées par des virgules, `*` pour toutes ; vide, la fédération est éteinte.
    // Une telle session ne porte jamais de cookie (`auth/federation.ts`).
    FEDERATION_ORIGINS: getEnvVar('FEDERATION_ORIGINS', 'string', false),

    // L'expéditeur des mails du serveur (validation d'une inscription). Sans
    // `SMTP_HOST`, rien ne part : le lien est écrit dans le journal du serveur.
    SMTP_HOST: getEnvVar('SMTP_HOST', 'string', false),
    SMTP_PORT: getEnvVar('SMTP_PORT', 'number', false) || 587,
    SMTP_USER: getEnvVar('SMTP_USER', 'string', false),
    SMTP_PASSWORD: getEnvVar('SMTP_PASSWORD', 'string', false),
    SMTP_FROM: getEnvVar('SMTP_FROM', 'string', false),

    RATE_LIMIT_MAX: getEnvVar('RATE_LIMIT_MAX', 'number', false) || 200,
    RATE_LIMIT_WINDOW: getEnvVar('RATE_LIMIT_WINDOW', 'string', false) || '1 minute',

    // Le temps accordé à une requête pour arriver en entier, corps compris. Le
    // défaut de Node (300 s) couperait un gros envoi sur une ligne ordinaire :
    // 5 Gio demandent 17 Mo/s soutenus. Fini et non nul : c'est ce qui borne un
    // corps envoyé au compte-gouttes. Le délai des en-têtes, lui, ne bouge pas.
    REQUEST_TIMEOUT_SECONDS: getEnvVar('REQUEST_TIMEOUT_SECONDS', 'number', false) || 7200,

    // Les appels sortants vers une adresse qu'un membre choisit (sondes Uptime,
    // webhooks, Dokploy, S3) peuvent-ils viser le réseau privé ? Fermé par
    // défaut : sur une instance partagée, ce serait offrir le réseau de l'hôte à
    // tout compte. À ouvrir sur une installation personnelle qui supervise son
    // propre réseau. Le lien-local (métadonnées cloud) reste fermé dans tous les cas.
    OUTBOUND_ALLOW_PRIVATE: getEnvVar('OUTBOUND_ALLOW_PRIVATE', 'boolean', false) ?? false,

    // Ce que Fastify croit de `X-Forwarded-For` : un nombre de sauts, ou une
    // liste d'adresses/CIDR séparées par des virgules. `true` ferait gagner
    // l'adresse la plus à gauche, celle que le client écrit lui-même, et toute
    // limite par IP (login, enrôlement) se contournerait par un en-tête.
    TRUST_PROXY: getEnvVar('TRUST_PROXY', 'string', false) || '1'
};

export const isDev = env.ENVIRONMENT === 'dev';

/**
 * Traduit `TRUST_PROXY` en valeur Fastify. Un entier n est « les n premiers
 * sauts depuis le serveur » (la forme numérique de proxy-addr, que le type de
 * Fastify n'expose pas : d'où la fonction).
 */
export function trustProxyOf(raw: string): string[] | ((address: string, hop: number) => boolean) {
    const trimmed = raw.trim();
    if (/^\d+$/.test(trimmed)) {
        const hops = Number(trimmed);
        return (_address, hop) => hop < hops;
    }
    return trimmed
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
}

export const TRUST_PROXY = trustProxyOf(env.TRUST_PROXY);

// Un secret court se brute-force au rythme d'un hachage, et la clé serveur ne
// vaut que ce que valent ses deux moitiés. Refuser au boot plutôt que tourner.
const SECRET_MIN_LENGTH = 32;
for (const name of [
    'CRYPT_KEY_A',
    'CRYPT_KEY_B',
    'JWT_ACCESS_SECRET',
    'JWT_REFRESH_SECRET',
    'DEVICE_TOKEN_SECRET'
] as const) {
    if (env[name].length < SECRET_MIN_LENGTH) {
        throw new Error(`${name} doit faire au moins ${SECRET_MIN_LENGTH} caractères (openssl rand -base64 48).`);
    }
}
if (env.DOMAIN_PROXY_TOKEN) {
    if (env.DOMAIN_PROXY_TOKEN.length < SECRET_MIN_LENGTH) {
        throw new Error(
            `DOMAIN_PROXY_TOKEN doit faire au moins ${SECRET_MIN_LENGTH} caractères (openssl rand -hex 32).`
        );
    }
    if (!env.DOMAIN_PROXY_UPSTREAM) {
        throw new Error('DOMAIN_PROXY_UPSTREAM est requis dès que DOMAIN_PROXY_TOKEN est renseigné.');
    }
}
if (env.SMTP_HOST && !env.SMTP_FROM) {
    throw new Error('SMTP_FROM est requis dès que SMTP_HOST est renseigné.');
}
// Un S3 à moitié décrit écrirait sur le disque sans le dire : on refuse.
if (env.STORAGE_S3_ENDPOINT) {
    const missing = (
        ['STORAGE_S3_REGION', 'STORAGE_S3_BUCKET', 'STORAGE_S3_ACCESS_KEY_ID', 'STORAGE_S3_SECRET_ACCESS_KEY'] as const
    ).filter((name) => !env[name]);
    if (missing.length > 0) {
        throw new Error(`${missing.join(', ')} requis dès que STORAGE_S3_ENDPOINT est renseigné.`);
    }
}
if (env.CRYPT_KEY_A === env.CRYPT_KEY_B) {
    throw new Error('CRYPT_KEY_A et CRYPT_KEY_B doivent différer.');
}

// Deux écouteurs sur le même port : un `EADDRINUSE` brut après le démarrage du
// serveur principal ne dirait rien de la cause. On refuse tout de suite.
if (env.PUBLIC_LISTEN_PORT && env.PUBLIC_LISTEN_PORT === env.LISTEN_PORT) {
    throw new Error(
        `PUBLIC_LISTEN_PORT (${env.PUBLIC_LISTEN_PORT}) doit différer de LISTEN_PORT : ce sont deux serveurs distincts, ` +
            "et c'est ce qui garde les routes internes hors d'atteinte du domaine public. Laisser PUBLIC_LISTEN_PORT vide " +
            'pour tout servir sur un seul port (cas du développement).'
    );
}
