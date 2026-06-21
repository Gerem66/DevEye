import { getEnvVar } from 'dotenv-oxy';

export const env = {
    ENVIRONMENT: getEnvVar('ENVIRONMENT', 'enum', ['dev', 'test', 'prod']),

    LISTEN_PORT: getEnvVar('LISTEN_PORT', 'number'),
    PUBLIC_ORIGIN: getEnvVar('PUBLIC_ORIGIN', 'string'),

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

    // Interim 2FA challenge token (between password check and TOTP verify).
    TWOFA_ISSUER: getEnvVar('TWOFA_ISSUER', 'string', false) || 'DevEye',
    TWOFA_CHALLENGE_TTL_SECONDS: getEnvVar('TWOFA_CHALLENGE_TTL_SECONDS', 'number', false) || 60 * 5,

    // Metrics/presence retention (days). A periodic job prunes older samples.
    METRICS_RETENTION_DAYS: getEnvVar('METRICS_RETENTION_DAYS', 'number', false) || 30,
    // Process-history retention (days). Separate (and shorter) default: process
    // samples are the bulkiest data.
    PROCESS_RETENTION_DAYS: getEnvVar('PROCESS_RETENTION_DAYS', 'number', false) || 1,

    COOKIE_DOMAIN: getEnvVar('COOKIE_DOMAIN', 'string', false),

    RATE_LIMIT_MAX: getEnvVar('RATE_LIMIT_MAX', 'number', false) || 200,
    RATE_LIMIT_WINDOW: getEnvVar('RATE_LIMIT_WINDOW', 'string', false) || '1 minute'
};

export const isDev = env.ENVIRONMENT === 'dev';
