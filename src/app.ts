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
import { env, TRUST_PROXY } from '@/Utils/Env';
import { registerWS } from '@/ws/handler';
import {
    createModuleServices,
    isModulePublicPath,
    moduleAgentHooks,
    modulePublicRoutes
} from '@/features/_sdk/register';
import { setSdkHost } from '@/features/_sdk/host';
import type { FeatureService } from '@deveye/types/sdk/server';
import { createAuditLog } from '@/Services/AuditLog';
import { createDomainVerifier } from '@/Services/domains/verifier';
import { status } from '@/status';

import type { Database } from '@/db';
import type Encryption from '@/Services/Encryption';

type FastifyCorsDelegateCallback = (error: Error | null, options: FastifyCorsOptions) => void;

/**
 * Le plafond d'une trame WebSocket, tous écouteurs confondus (le plugin ne
 * s'enregistre qu'une fois). Dimensionné sur la plus grosse commande légitime
 * du client : `user.setTheme`, un fond d'écran et cinq emplacements en data URL
 * (`THEME_IMAGE_MAX_LENGTH` + 5 × `THEME_SLOT_IMAGE_MAX_LENGTH`, ~11,7 Mo). Le
 * défaut de `ws` est 100 Mio, analysés en JSON avant toute validation. La
 * socket des agents se borne plus bas (`agent/ws.ts`).
 */
export const WS_MAX_PAYLOAD = 12 * 1024 * 1024;

/**
 * La politique de contenu du client. `script-src 'self'` est ce qui compte :
 * un contournement du nettoyeur HTML (corps de mail) ou un lien `javascript:`
 * ne peut plus exécuter de code. `style-src 'unsafe-inline'` reste nécessaire
 * au thème (styles inline, `setProperty`) ; `img-src https:` aux fonds d'écran
 * et avatars distants, `frame-src 'self'` au corps de mail en bac à sable.
 */
export const CONTENT_SECURITY_POLICY = {
    useDefaults: false,
    directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'", "'unsafe-inline'"],
        'img-src': ["'self'", 'data:', 'blob:', 'https:'],
        'font-src': ["'self'", 'data:'],
        // Hors de soi, seulement ce que le widget « IP publique » interroge : lui
        // seul peut demander l'adresse du navigateur, le serveur verrait la sienne
        // (ou celle du VPN).
        'connect-src': [
            "'self'",
            'https://api.ipify.org',
            'https://api6.ipify.org',
            'https://ipv4.icanhazip.com',
            'https://ipv6.icanhazip.com',
            'https://ipwho.is'
        ],
        'frame-src': ["'self'"],
        'worker-src': ["'self'", 'blob:'],
        'frame-ancestors': ["'none'"],
        'base-uri': ["'none'"],
        'object-src': ["'none'"],
        'form-action': ["'self'"]
    }
} as const;

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
        trustProxy: TRUST_PROXY
    });

    await app.register(fastifyHelmet, { contentSecurityPolicy: CONTENT_SECURITY_POLICY });

    // CORS délégué par requête : tout DevEye n'accepte que `PUBLIC_ORIGIN` avec
    // les cookies, sauf les routes publiques des modules (capacité
    // `routes.public`), appelées depuis des sites tiers : toute origine, sans
    // identifiants. Le délégateur est la seule forme qui voie le chemin.
    // Ce n'est pas la protection de ces routes : ce qui filtre, c'est la liste
    // d'origines par site vérifiée côté serveur par le module.
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
    await app.register(fastifyWebsocket, { options: { maxPayload: WS_MAX_PAYLOAD } });

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
    // envelope: Fastify's default body matches neither the web client's decoder
    // nor the agent's. 5xx are logged with the stack; their message stays generic.
    app.setErrorHandler((error: FastifyError, req, reply) => {
        const explicit = typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500;
        const status = explicit ? (error.statusCode as number) : 500;
        if (status >= 500) req.log.error({ err: error }, 'unhandled request error');
        else req.log.warn({ err: error, status }, 'request error');
        const code: ErrorCode = error.validation || status === 400 ? 'validation' : 'internal';
        const message = status >= 500 ? 'Erreur interne du serveur' : error.message || 'Requête invalide';
        return reply.code(status).send(err(code, message));
    });

    // `text/plain` porteur de JSON : la forme qu'émet `navigator.sendBeacon`
    // sans requête préalable OPTIONS. Un corps illisible rend `undefined`, que
    // la validation zod des routes publiques écarte comme le reste.
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

    // `application/x-www-form-urlencoded` : ce qu'émet un `<form method="post">`
    // sans une ligne de JavaScript, la seule forme qu'un site vraiment statique
    // sait produire. Un nom répété devient un tableau, sans quoi un groupe de
    // cases à cocher perdrait toutes ses valeurs sauf une.
    app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
        if (!body) {
            done(null, undefined);
            return;
        }
        const fields: Record<string, string | string[]> = {};
        for (const [name, value] of new URLSearchParams(body as string)) {
            const seen = fields[name];
            if (seen === undefined) fields[name] = value;
            else if (Array.isArray(seen)) seen.push(value);
            else fields[name] = [seen, value];
        }
        done(null, fields);
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
    // Aucune commande sans garde déclarée : lever plutôt qu'avertir, un `access`
    // oublié ouvre une commande en silence.
    assertAccessDeclared(featureHandlers);
    const audit = createAuditLog(deps.db);
    // Les services des modules démarrent ici, awaités, avant l'enregistrement
    // des sockets : un module d'infrastructure (bail, clés) doit être prêt
    // avant la première trame d'agent.
    setSdkHost(hub, deps.db, live);
    const moduleServices = [
        ...createModuleServices({ db: deps.db, crypt: deps.crypt, audit, logger, live }),
        createDomainVerifier({ db: deps.db, crypt: deps.crypt, logger, live })
    ];
    for (const svc of moduleServices) await svc.start();

    await authRoutes(app, { db: deps.db, crypt: deps.crypt, audit, live });
    await agentRoutes(app, { db: deps.db, hub, live, audit });
    // Routes publiques des modules (capacité `routes.public`), aussi montées
    // sur la surface publique quand elle existe (`publicApp.ts`). Après la
    // création des services, qui les déclarent.
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
            index: ['index.html'],
            allowedPath: (pathName) => !pathName.endsWith('.map')
        });

        // SPA fallback: any non-API/WS GET that didn't match a static asset
        // returns index.html so client-side routing can take over. Les cartes de
        // source du build ne sortent jamais : elles portent le code commenté.
        app.setNotFoundHandler((req, reply) => {
            if (req.url.endsWith('.map')) return reply.code(404).send({ error: 'not_found' });
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
