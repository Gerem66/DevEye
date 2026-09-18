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
        // Un joker pino vaut EXACTEMENT un niveau, jamais « à n'importe quelle
        // profondeur » : `*.password` efface `{ user: { password } }`, et laisse
        // passer aussi bien `{ password }` que `{ req: { body: { password } } }`.
        // D'où chaque nom décliné aux trois profondeurs où l'app journalise : la
        // racine, un objet imbriqué, le corps d'une requête. Plus bas, rien n'est
        // effacé ; chaque niveau de plus coûte un chemin par nom.
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
