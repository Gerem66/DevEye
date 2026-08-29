import fastifyCors from '@fastify/cors';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyBaseLogger, type FastifyError, type FastifyInstance } from 'fastify';
import { err, type ErrorCode } from '@deveye/types';

import { modulePublicRoutes } from '@/features/_sdk/register';
import { logger } from '@/logger';
import { env, isDev } from '@/Utils/Env';

/**
 * Le serveur public : un second écouteur, sur son propre port, qui ne porte que
 * les routes publiques des modules (capacité `routes.public`).
 *
 * Écouteur séparé plutôt que garde sur `Host` ou règle de proxy : les routes
 * internes n'y sont pas enregistrées, la séparation ne dépend d'aucune
 * configuration. D'où l'absence de cookies, WebSocket, statiques et repli SPA.
 *
 * Même processus que `app.ts` par contrainte : les modules préviennent les
 * écrans par `LiveHub`, dont l'état est local au processus ; les routes viennent
 * des services déjà créés par `buildApp`.
 *
 * Le harnais (helmet, débit, analyseurs, erreurs) est volontairement dupliqué
 * depuis `app.ts` : les politiques diffèrent, et ce port doit se relire seul.
 */
export async function buildPublicApp(): Promise<FastifyInstance> {
    const app = Fastify({
        loggerInstance: logger.child({ surface: 'public' }) as FastifyBaseLogger,
        // Le plafond de débit compte par IP : sans cela il verrait celle du
        // proxy, et un seul visiteur actif fermerait la porte à tous.
        trustProxy: !isDev
    });

    await app.register(fastifyHelmet, { contentSecurityPolicy: false });

    // Toute origine, sans identifiants : il n'y a aucune session à transporter.
    await app.register(fastifyCors, { origin: '*', credentials: false, methods: ['GET', 'POST'] });

    await app.register(fastifyRateLimit, {
        max: env.RATE_LIMIT_MAX,
        timeWindow: env.RATE_LIMIT_WINDOW
    });

    // `text/plain` porteur de JSON : la forme qu'émet `navigator.sendBeacon`
    // sans déclencher de requête préalable OPTIONS. Un corps illisible rend
    // `undefined`, que la validation zod du module écarte comme le reste.
    app.addContentTypeParser('text/plain', { parseAs: 'string' }, (_req, body, done) => {
        if (!body) {
            done(null, undefined);
            return;
        }
        try {
            done(null, JSON.parse(body as string));
        } catch {
            done(null, undefined);
        }
    });

    app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
        if (!body) {
            done(null, undefined);
            return;
        }
        try {
            done(null, JSON.parse(body as string));
        } catch {
            done(null, undefined);
        }
    });

    // Aucune erreur ne raconte quoi que ce soit du serveur : ce port est exposé,
    // et un message d'erreur détaillé y serait un renseignement gratuit.
    app.setErrorHandler((error: FastifyError, req, reply) => {
        const explicit = typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500;
        const status = explicit ? (error.statusCode as number) : 500;
        if (status >= 500) req.log.error({ err: error }, 'unhandled public request error');
        const code: ErrorCode = status === 400 ? 'validation' : 'internal';
        return reply.code(status).send(err(code, status >= 500 ? 'Erreur interne' : 'Requête invalide'));
    });

    // Sonde de vivacité seulement : ni version ni état de la base, `/api/status`
    // reste sur le port privé.
    app.get('/api/health', { logLevel: 'silent' }, async () => ({ ok: true }));

    modulePublicRoutes(app, 'public');

    // Pas de repli SPA : tout ce qui n'est pas déclaré ci-dessus n'existe pas.
    // C'est la différence avec `app.ts`, où un GET inconnu rend `index.html`.
    app.setNotFoundHandler((_req, reply) => reply.code(404).send(err('not_found', 'Introuvable')));

    return app;
}
