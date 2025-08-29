import { getEnvVar } from 'dotenv-oxy';

export const env = {
    // Environment
    ENVIRONMENT: getEnvVar('ENVIRONMENT', 'enum', ['dev', 'test', 'prod']),

    // Servers
    HTTP_SERVER_URL: getEnvVar('HTTP_SERVER_URL', 'string'),
    LISTEN_PORT: getEnvVar('LISTEN_PORT', 'number'),
    MAX_CONNECTIONS: getEnvVar('MAX_CONNECTIONS', 'number'),

    // Logs management
    LOG_LEVEL: getEnvVar('LOG_LEVEL', 'enum', ['minimal', 'normal', 'all']),
    LOG_PATH: getEnvVar('LOG_PATH', 'string'),
    LOG_KEEP_DAYS: getEnvVar('LOG_KEEP_DAYS', 'number'),

    // Network configuration
    MAX_RECEIVED_FRAME_SIZE: getEnvVar('MAX_RECEIVED_FRAME_SIZE', 'number'),
    MAX_RECEIVED_MESSAGE_SIZE: getEnvVar('MAX_RECEIVED_MESSAGE_SIZE', 'number'),

    // SSL configuration
    SSL_PRIVATE_KEY_PATH: getEnvVar('SSL_PRIVATE_KEY_PATH', 'string', false),
    SSL_CERTIFICATE_PATH: getEnvVar('SSL_CERTIFICATE_PATH', 'string', false),

    // Database configuration
    DB_HOSTNAME: getEnvVar('DB_HOSTNAME', 'string'),
    DB_PORT: getEnvVar('DB_PORT', 'number', false) || 3306,
    DB_DATABASE: getEnvVar('DB_DATABASE', 'string'),
    DB_USERNAME: getEnvVar('DB_USERNAME', 'string'),
    DB_PASSWORD: getEnvVar('DB_PASSWORD', 'string'),

    // Encryption configuration
    CRYPT_METHOD: getEnvVar('CRYPT_METHOD', 'enum', ['aes-128-gcm']),
    CRYPT_KEY_A: getEnvVar('CRYPT_KEY_A', 'string'),
    CRYPT_KEY_B: getEnvVar('CRYPT_KEY_B', 'string')
};
