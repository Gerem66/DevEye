import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import fastifyCookie from '@fastify/cookie';
import fastifyCors, { type FastifyCorsOptions } from '@fastify/cors';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyBaseLogger, type FastifyError, type FastifyInstance, type FastifyRequest } from 'fastify';
import { err, ok, serverStatusSchema, type ErrorCode } from '@deveye/types';

import { agentRoutes } from '@/agent/routes';
import { audienceRoutes } from '@/audience/routes';
import { registerAgentWS } from '@/agent/ws';
import { MonitorHub } from '@/agent/hub';
import { LiveHub } from '@/live/hub';
import { assertAccessDeclared } from '@/features/_permissions';
import { featureHandlers } from '@/features/registry';
import { buildTopicIndex } from '@/features/_topics';
import { authRoutes } from '@/auth/routes';
import { logger } from '@/logger';
import { env, isDev } from '@/Utils/Env';
import { registerWS } from '@/ws/handler';
import { createModuleServices, moduleAgentHooks, registerNativeProvider } from '@/features/_sdk/register';
import { setSdkHost } from '@/features/_sdk/host';
import type { FeatureService } from '@deveye/types/sdk/server';
import { createAuditLog } from '@/Services/AuditLog';
import { MailSyncService } from '@/Services/MailSyncService';
import { IntegrationSyncService } from '@/Services/IntegrationSyncService';
import { DatabaseMonitor } from '@/Services/DatabaseMonitor';
import { AudienceIngest } from '@/Services/AudienceIngest';
import { createDatabaseBackupProvider, DATABASE_BACKUP_PROVIDER } from '@/features/database/backupProvider';
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
    /** Services des modules installés — démarrés ici, arrêtés par index.ts. */
    moduleServices: readonly FeatureService[];
    integrations: IntegrationSyncService;
    databases: DatabaseMonitor;
    /** Ingestion d'audience — démarrée/arrêtée par index.ts. */
    audience: AudienceIngest;
    /** Ordonnanceur des sauvegardes — démarré/arrêté par index.ts. */
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
    // La diffusion traverse les projections : un espace est prévenu des
    // écritures faites chez ceux qui partagent avec lui, dans les deux sens.
    live.setShareLinks((workspaceId, feature) => deps.db.itemSharing.linkedWorkspaces(workspaceId, feature));
    live.startHeartbeat();
    // Même battement pour les sockets agent : une machine éteinte ne referme
    // jamais la sienne, et restait « en ligne » jusqu'au keepalive TCP du noyau.
    hub.startHeartbeat();
    // Résout « quelle commande touche à quoi » une fois pour toutes, et signale
    // les commandes mutantes qui auraient oublié de le déclarer.
    buildTopicIndex();
    // Et le contrôle d'autorisation : aucune commande sans garde déclarée.
    // Lever ici plutôt qu'avertir — un `access` oublié ouvre une commande en
    // silence, et l'interface qui masque la donnée fait croire à une garde.
    assertAccessDeclared(featureHandlers);
    const audit = createAuditLog(deps.db);
    // Le hub se dépose pour l'assemblage SDK (façade agents des modules),
    // puis les services des modules installés démarrent ICI, awaités, avant
    // l'enregistrement des sockets : un module d'infrastructure (bail, clés)
    // doit être prêt avant la première trame d'agent, exactement comme le
    // moteur d'un module d'infrastructure (CloudSync) l'exige.
    setSdkHost(hub, deps.db);
    const moduleServices = createModuleServices({ db: deps.db, crypt: deps.crypt, audit, logger, live });
    for (const svc of moduleServices) await svc.start();

    const mailSync = new MailSyncService({ db: deps.db, crypt: deps.crypt, logger, live });
    const integrations = new IntegrationSyncService({ db: deps.db, crypt: deps.crypt, logger, live });
    // Bases de données a **ses propres** canaux (`notification_settings`, ligne
    // `database`), depuis la migration 085. Elle empruntait ceux d'Uptime, et un
    // seuil SQL franchi arrivait donc sur le salon désigné pour la
    // disponibilité — la même erreur que Sentinelle avant la 075, corrigée de la
    // même façon, reprise de la ligne existante comprise.
    const databases = new DatabaseMonitor({ db: deps.db, crypt: deps.crypt, logger, live });
    // Ce que le module Sauvegardes demande aux bases (noms, accès ouvert,
    // tunnel compris), offert par l'app tant que la feature est native. Le
    // module le lit par `providers.get` sans savoir qui l'offre.
    registerNativeProvider(
        DATABASE_BACKUP_PROVIDER,
        createDatabaseBackupProvider({ db: deps.db, crypt: deps.crypt, databases })
    );
    // L'ingestion d'audience. Rien à joindre au-dehors : contrairement aux
    // trois services ci-dessus, celui-ci ne sonde rien — il **reçoit**, et son
    // seul travail périodique est de vider ce qu'on lui a déposé.
    const audience = new AudienceIngest({ db: deps.db, crypt: deps.crypt, logger, live });
    // (Le moteur de Sentinelle est un service du module `features/sentinel`,
    // démarré avec les autres ci-dessus ; ses relevés lui arrivent par les
    // hooks agent.)
    // (Les sauvegardes sont un service du module `features/backup` : la flotte
    // d'agents par sa façade, CloudSync et les bases par leurs contrats.)

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
        integrations,
        databases,
        audience,
        audit
    });
    // Les modules reçoivent ce que les agents envoient, une fois persisté, par
    // l'agrégat des hooks ; aucun n'évalue sur ce chemin (le moteur de
    // Sentinelle empile, son tour de boucle évalue).
    await registerAgentWS(app, { db: deps.db, hub, live, hooks: moduleAgentHooks(), audit });

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

    return { app, mailSync, integrations, databases, audience, moduleServices };
}
