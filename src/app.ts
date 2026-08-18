import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import fastifyCookie from '@fastify/cookie';
import fastifyCors, { type FastifyCorsOptions } from '@fastify/cors';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyBaseLogger, type FastifyError, type FastifyInstance, type FastifyRequest } from 'fastify';
import { err, ok, serverStatusSchema, type ErrorCode } from 'deveye-types';

import { agentRoutes } from '@/agent/routes';
import { audienceRoutes } from '@/audience/routes';
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
import { AudienceIngest } from '@/Services/AudienceIngest';
import { SecurityMonitor } from '@/Services/SecurityMonitor';
import { mailAttachmentRoutes } from '@/mail/attachmentRoutes';
import { mailOAuthRoutes } from '@/mail/oauthRoutes';
import { status } from '@/status';

import type { Database } from '@/db';
import type Encryption from '@/Services/Encryption';

/** Ce que le délégateur CORS rend pour une requête donnée. */
type FastifyCorsDelegateCallback = (error: Error | null, options: FastifyCorsOptions) => void;

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
    /** Ingestion d'audience — démarrée/arrêtée par index.ts. */
    audience: AudienceIngest;
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

    // CORS **délégué par requête**, et non fixé une fois pour toutes.
    //
    // Tout DevEye n'accepte que `PUBLIC_ORIGIN`, avec les cookies de session.
    // L'ingestion d'audience, elle, est appelée depuis des sites tiers qu'on ne
    // connaît pas d'avance : elle doit accepter n'importe quelle origine, et
    // surtout **sans** identifiants — il n'y a aucune session à y transporter.
    //
    // Le délégateur est la seule forme qui reçoive la requête ; `origin` seul ne
    // voit pas le chemin, et une instance encapsulée aurait fait vivre les
    // routes publiques dans un contexte Fastify séparé pour un seul en-tête.
    //
    // ⚠️ Ce n'est pas la protection de l'ingestion. Le CORS est un mécanisme
    // que le navigateur applique à lui-même ; ce qui filtre réellement, c'est la
    // liste d'origines **par site** vérifiée côté serveur (`originAllowed`).
    await app.register(fastifyCors, () => (req: FastifyRequest, callback: FastifyCorsDelegateCallback) => {
        const url = req.url ?? '';
        if (url.startsWith('/api/t/') || url === '/t.js' || url.startsWith('/t.js?')) {
            callback(null, { origin: '*', credentials: false, methods: ['GET', 'POST'] });
            return;
        }
        callback(null, { origin: env.PUBLIC_ORIGIN, credentials: true, methods: ['GET', 'POST'] });
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

    // `text/plain` porteur de JSON : c'est ce que `navigator.sendBeacon` sait
    // envoyer sans déclencher de requête préalable OPTIONS, et donc la seule
    // forme qui traverse une page tierce en un aller simple. Aucune autre route
    // n'accepte ce type ; un corps illisible rend `undefined`, que la validation
    // zod de l'ingestion écarte comme le reste.
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
    // Bases de données a **ses propres** canaux (`notification_settings`, ligne
    // `database`), depuis la migration 085. Elle empruntait ceux d'Uptime, et un
    // seuil SQL franchi arrivait donc sur le salon désigné pour la
    // disponibilité — la même erreur que Sentinelle avant la 075, corrigée de la
    // même façon, reprise de la ligne existante comprise.
    const databases = new DatabaseMonitor({ db: deps.db, crypt: deps.crypt, logger, live });
    // L'ingestion d'audience. Rien à joindre au-dehors : contrairement aux
    // quatre services ci-dessus, celui-ci ne sonde rien — il **reçoit**, et son
    // seul travail périodique est de vider ce qu'on lui a déposé.
    const audience = new AudienceIngest({ db: deps.db, crypt: deps.crypt, logger, live });
    // Sentinelle a **ses propres** canaux (`notification_settings`, ligne
    // `sentinel`). Elle empruntait ceux d'Uptime : une alerte de sécurité
    // arrivait alors sur un salon désigné pour la disponibilité, sans que rien
    // ne l'ait annoncé ni ne permette de l'éteindre séparément.
    const sentinel = new SecurityMonitor({ db: deps.db, crypt: deps.crypt, logger, audit, live });

    await authRoutes(app, { db: deps.db, crypt: deps.crypt, audit });
    await agentRoutes(app, { db: deps.db, hub, live, audit });
    await audienceRoutes(app, { ingest: audience });
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
        audience,
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

    return { app, cloudSync, uptime, mailSync, integrations, databases, audience, sentinel };
}
