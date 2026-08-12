import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import fastifyCookie from '@fastify/cookie';
import fastifyCors from '@fastify/cors';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyBaseLogger, type FastifyError, type FastifyInstance } from 'fastify';
import { err, ok, serverStatusSchema, type ErrorCode } from 'deveye-types';

import { agentRoutes } from '@/agent/routes';
import { registerAgentWS } from '@/agent/ws';
import { MonitorHub } from '@/agent/hub';
import { LiveHub } from '@/live/hub';
import { buildTopicIndex } from '@/features/_topics';
import { authRoutes } from '@/auth/routes';
import { CloudSyncEngine } from '@/cloudSync/engine';
import { logger } from '@/logger';
import { env, isDev } from '@/Utils/Env';
import { registerWS } from '@/ws/handler';
import { createAuditLog } from '@/Services/AuditLog';
import { MailSyncService } from '@/Services/MailSyncService';
import { UptimeMonitor } from '@/Services/UptimeMonitor';
import { IntegrationSyncService } from '@/Services/IntegrationSyncService';
import { DatabaseMonitor } from '@/Services/DatabaseMonitor';
import { SecurityMonitor } from '@/Services/SecurityMonitor';
import { mailAttachmentRoutes } from '@/mail/attachmentRoutes';
import { mailOAuthRoutes } from '@/mail/oauthRoutes';
import { status } from '@/status';

import type { Database } from '@/db';
import type Encryption from '@/Services/Encryption';

export interface AppDeps {
    db: Database;
    crypt: Encryption;
}

export interface BuiltApp {
    app: FastifyInstance;
    /** Moteur CloudSync — exposé pour le prune horaire de index.ts. */
    cloudSync: CloudSyncEngine;
    /** Ordonnanceur Uptime — démarré/arrêté par index.ts. */
    uptime: UptimeMonitor;
    integrations: IntegrationSyncService;
    databases: DatabaseMonitor;
    /** Moteur Sentinelle — démarré/arrêté par index.ts. */
    sentinel: SecurityMonitor;
    /** Synchro Mail en tâche de fond (comptes « open » uniquement) — démarrée/arrêtée par index.ts. */
    mailSync: MailSyncService;
}

export async function buildApp(deps: AppDeps): Promise<BuiltApp> {
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

    // Turn any uncaught route error into the app's standard {ok:false,error}
    // envelope. Fastify's default {statusCode,error,message} body matches neither
    // the web client's decoder nor the agent's (the agent crashed on it with
    // "invalid type: string, expected struct ApiError"). 5xx are logged with the
    // stack so the real cause is visible; their message is kept generic (no leak).
    app.setErrorHandler((error: FastifyError, req, reply) => {
        const explicit = typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500;
        const status = explicit ? (error.statusCode as number) : 500;
        if (status >= 500) req.log.error({ err: error }, 'unhandled request error');
        else req.log.warn({ err: error, status }, 'request error');
        const code: ErrorCode = error.validation || status === 400 ? 'validation' : 'internal';
        const message = status >= 500 ? 'Erreur interne du serveur' : error.message || 'Requête invalide';
        return reply.code(status).send(err(code, message));
    });

    app.get('/api/health', { logLevel: 'silent' }, async () => ({ ok: true }));

    // Boot/deployment readiness (agent sync + future steps). Public + cheap so
    // the client can show a discreet topbar zone until the server is fully ready.
    app.get('/api/status', { logLevel: 'silent' }, async () => ok(serverStatusSchema.parse(status.snapshot())));

    const hub = new MonitorHub();
    // Construit avant les services de fond : ils lui adressent leurs changements
    // (ils écrivent sans commande utilisateur, donc sans socket pour diffuser).
    const live = new LiveHub();
    live.startHeartbeat();
    // Même battement pour les sockets agent : une machine éteinte ne referme
    // jamais la sienne, et restait « en ligne » jusqu'au keepalive TCP du noyau.
    hub.startHeartbeat();
    // Résout « quelle commande touche à quoi » une fois pour toutes, et signale
    // les commandes mutantes qui auraient oublié de le déclarer.
    buildTopicIndex();
    const audit = createAuditLog(deps.db);
    const cloudSync = new CloudSyncEngine({ db: deps.db, hub, crypt: deps.crypt, audit, logger });
    await cloudSync.start();

    const uptime = new UptimeMonitor({ db: deps.db, crypt: deps.crypt, audit, logger, live });
    const mailSync = new MailSyncService({ db: deps.db, crypt: deps.crypt, logger, live });
    const integrations = new IntegrationSyncService({ db: deps.db, crypt: deps.crypt, logger, live });
    // Les canaux de notification sont ceux d'Uptime : mêmes destinataires, une
    // seule configuration à tenir à jour.
    const databases = new DatabaseMonitor({ db: deps.db, crypt: deps.crypt, logger, live, uptime });
    // Sentinelle a **ses propres** canaux (`notification_settings`, ligne
    // `sentinel`). Elle empruntait ceux d'Uptime : une alerte de sécurité
    // arrivait alors sur un salon désigné pour la disponibilité, sans que rien
    // ne l'ait annoncé ni ne permette de l'éteindre séparément.
    const sentinel = new SecurityMonitor({ db: deps.db, crypt: deps.crypt, logger, audit, live });

    await authRoutes(app, { db: deps.db, crypt: deps.crypt, audit });
    await agentRoutes(app, { db: deps.db, hub, live, audit });
    await mailOAuthRoutes(app, { db: deps.db, crypt: deps.crypt, audit });
    await mailAttachmentRoutes(app, { db: deps.db, crypt: deps.crypt });
    await registerWS(app, {
        db: deps.db,
        crypt: deps.crypt,
        hub,
        live,
        cloudSync,
        uptime,
        integrations,
        databases,
        sentinel,
        audit
    });
    // Le moteur reçoit ce que les agents envoient — mais il n'évalue rien ici :
    // les handlers empilent, le tour de boucle évalue (voir `SecurityMonitor`).
    await registerAgentWS(app, { db: deps.db, hub, live, cloudSync, sentinel, audit });

    // Serve the built web client from the same origin as the API whenever a
    // build is present (production, or the dockerised dev stack). On the host
    // dev workflow there is no build dir: Vite (port 5173) serves the client
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

    return { app, cloudSync, uptime, mailSync, integrations, databases, sentinel };
}
