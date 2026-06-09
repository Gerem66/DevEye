import { env, isDev } from '@/Utils/Env';
import pino from 'pino';

export const logger = pino({
    level: env.LOG_LEVEL,
    base: { service: 'deveye-server' },
    redact: {
        paths: [
            'req.headers.authorization',
            'req.headers.cookie',
            'res.headers["set-cookie"]',
            '*.password',
            '*.token',
            '*.refresh'
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
