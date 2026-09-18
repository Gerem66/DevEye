import { env, isDev } from '@/Utils/Env';
import pino from 'pino';

/** Les noms de champ qui ne doivent jamais sortir dans un journal, où qu'ils soient. */
const SECRET_KEYS = [
    'password',
    'currentPassword',
    'newPassword',
    'token',
    'refresh',
    'secret',
    'apiKey',
    'accessToken',
    'refreshToken',
    'deviceToken',
    'webhookUrl',
    'recoveryCode',
    'dek'
];

export const logger = pino({
    level: env.LOG_LEVEL,
    base: { service: 'deveye-server' },
    redact: {
        // Le joker de pino ne descend que d'un niveau : chaque nom est donc
        // répété à deux profondeurs, celle d'un objet journalisé et celle d'un
        // objet imbriqué (`{ account: { password } }`).
        paths: [
            'req.headers.authorization',
            'req.headers.cookie',
            'res.headers["set-cookie"]',
            ...SECRET_KEYS.flatMap((key) => [key, `*.${key}`, `*.*.${key}`])
        ],
        remove: true
    },
    transport: isDev
        ? {
              target: 'pino-pretty',
              options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' }
          }
        : undefined
});
