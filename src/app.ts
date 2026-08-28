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
import {
    createModuleServices,
    isModulePublicPath,
    moduleAgentHooks,
    modulePublicRoutes,
    registerNativeProvider
} from '@/features/_sdk/register';
import { setSdkHost } from '@/features/_sdk/host';
import type { FeatureService } from '@deveye/types/sdk/server';
import { createAuditLog } from '@/Services/AuditLog';
import { createProjectsUsageProvider, PROJECTS_USAGE_PROVIDER } from '@/features/project/usageProvider';
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
    // Les routes publiques des modules (capacité `routes.public` : l'ingestion
    // d'audience et son script), elles, sont appelées depuis des sites tiers
    // qu'on ne connaît pas d'avance : elles doivent accepter n'importe quelle
    // origine, et surtout **sans** identifiants, il n'y a aucune session à y
    // transporter. `isModulePublicPath` connaît leurs chemins : ce sont ceux
    // que `modulePublicRoutes` a montés ci-dessous.
    //
    // Le délégateur est la seule forme qui reçoive la requête ; `origin` seul ne
    // voit pas le chemin, et une instance encapsulée aurait fait vivre les
    // routes publiques dans un contexte Fastify séparé pour un seul en-tête.
    //
    // ⚠️ Ce n'est pas la protection de ces routes. Le CORS est un mécanisme
    // que le navigateur applique à lui-même ; ce qui filtre réellement, c'est
    // la liste d'origines **par site** vérifiée côté serveur par le module
    // (`originAllowed`, dans `features/audience`).
    await app.register(fastifyCors, () => (req: FastifyRequest, callback: FastifyCorsDelegateCallback) => {
        if (isModulePublicPath(req.url ?? '')) {
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
    // forme qui traverse une page tierce en un aller simple. Seules les routes
    // publiques des modules (l'ingestion d'audience) reçoivent ce type ; un
    // corps illisible rend `undefined`, que leur validation zod écarte comme
    // le reste.
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

    // Ce que les modules Bases de données, Déploiements, Git et Audience
    // demandent à Projets (les projets de l'espace qui relient un élément, et
    // combien par élément ; la frise d'un projet pour un déploiement parti de
    // son onglet ; la version d'un projet qui suit les releases d'un dépôt),
    // offert par l'app tant que Projets est native. Les modules le lisent par
    // `providers.get` sans savoir qui l'offre ; le jour où Projets migre, son
    // service publie la même clé et ce fichier disparaît.
    registerNativeProvider(PROJECTS_USAGE_PROVIDER, createProjectsUsageProvider({ db: deps.db, crypt: deps.crypt }));
    // (Le moteur de Sentinelle est un service du module `features/sentinel`,
    // démarré avec les autres ci-dessus ; ses relevés lui arrivent par les
    // hooks agent.)
    // (Les sauvegardes sont un service du module `features/backup` : la flotte
    // d'agents par sa façade, CloudSync et les bases par leurs contrats. Le
    // relevé des bases est un service du module `features/database`, qui
    // publie ces contrats lui-même. Le rapprochement des cibles de déploiement
    // est un service du module `features/deploy`, la synchronisation des
    // dépôts git un service du module `features/git` : l'ex
    // `IntegrationSyncService`, rendu moitié par moitié à ses deux features.
    // L'ingestion d'audience est un service du module `features/audience`,
    // la seule qui ne sonde rien : elle **reçoit**, par les routes publiques
    // montées ci-dessous, et son seul travail périodique est de vider ce
    // qu'on lui a déposé. La relève des boîtes mail ouvertes est un service
    // du module `features/mail`, qui offre aussi le transport des alertes
    // e-mail (`MAIL_TRANSPORT_PROVIDER`) et ses deux routes à ticket.)

    await authRoutes(app, { db: deps.db, crypt: deps.crypt, audit });
    await agentRoutes(app, { db: deps.db, hub, live, audit });
    // Les routes publiques des modules (capacité `routes.public`) : sur cet
    // écouteur-ci, et sur la surface publique quand elle existe
    // (`publicApp.ts`, où celles à `exposure: 'app'`, comme les deux de Mail,
    // ne montent pas). Après la création des services, qui les déclarent.
    modulePublicRoutes(app, 'app');
    await registerWS(app, {
        db: deps.db,
        crypt: deps.crypt,
        hub,
        live,
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

    return { app, moduleServices };
}
