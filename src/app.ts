import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import fastifyCookie from '@fastify/cookie';
import fastifyCors from '@fastify/cors';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';

import { authRoutes } from '@/auth/routes';
import { logger } from '@/logger';
import { env, isDev } from '@/Utils/Env';
import { registerWS } from '@/ws/handler';

import type { Database } from '@/db';
import type Encryption from '@/Services/Encryption';

export interface AppDeps {
    db: Database;
    crypt: Encryption;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
    const app = Fastify({
        loggerInstance: logger as FastifyBaseLogger,
        trustProxy: !isDev
    });

    await app.register(fastifyHelmet, { contentSecurityPolicy: false });
    await app.register(fastifyCors, {
        origin: env.PUBLIC_ORIGIN,
        credentials: true,
        methods: ['GET', 'POST']
    });
    await app.register(fastifyCookie);
    await app.register(fastifyRateLimit, {
        max: env.RATE_LIMIT_MAX,
        timeWindow: env.RATE_LIMIT_WINDOW
    });
    await app.register(fastifyWebsocket);

    // Tolerate empty JSON bodies: cookie-based POSTs (e.g. /api/auth/refresh,
    // /api/auth/logout) send `Content-Type: application/json` with no body, which
    // Fastify 5 rejects by default (FST_ERR_CTP_EMPTY_JSON_BODY).
    app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
        if (!body) {
            done(null, undefined);
            return;
        }
        try {
            done(null, JSON.parse(body as string));
        } catch {
            const e = new Error('Invalid JSON body') as Error & { statusCode?: number };
            e.statusCode = 400;
            done(e, undefined);
        }
    });

    app.get('/api/health', async () => ({ ok: true }));

    await authRoutes(app, { db: deps.db });
    await registerWS(app, { db: deps.db, crypt: deps.crypt });

    // Serve the built web client from the same origin as the API whenever a
    // build is present (production, or the dockerised dev stack). On the host
    // dev workflow there is no build dir: Vite (port 3000) serves the client
    // and proxies /api and /ws to this server.
    const clientDir = process.env.CLIENT_DIR
        ? resolve(process.env.CLIENT_DIR)
        : resolve(process.cwd(), 'client', 'build');

    if (existsSync(clientDir)) {
        await app.register(fastifyStatic, {
            root: clientDir,
            wildcard: false,
            index: ['index.html']
        });

        // SPA fallback: any non-API/WS GET that didn't match a static asset
        // returns index.html so client-side routing can take over.
        app.setNotFoundHandler((req, reply) => {
            if (req.method === 'GET' && !req.url.startsWith('/api') && !req.url.startsWith('/ws')) {
                return reply.sendFile('index.html');
            }
            return reply.code(404).send({ error: 'not_found' });
        });
    } else {
        app.log.debug({ clientDir }, 'No client build found; static serving disabled (host dev uses Vite)');
    }

    return app;
}
