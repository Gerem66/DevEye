import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import fastifyCookie from '@fastify/cookie';
import fastifyCors, { type FastifyCorsOptions } from '@fastify/cors';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyBaseLogger, type FastifyError, type FastifyInstance, type FastifyRequest } from 'fastify';
import {
    BUILD_MANIFEST_PATH,
    type ErrorCode,
    err,
    ok,
    publicMaintenanceSchema,
    serverStatusSchema
} from '@deveye/types';

import { agentRoutes } from '@/agent/routes';
import { registerAgentWS } from '@/agent/ws';
import { MonitorHub } from '@/agent/hub';
import { LiveHub } from '@/live/hub';
import { assertAccessDeclared } from '@/features/_permissions';
import { featureHandlers } from '@/features/registry';
import { buildTopicIndex } from '@/features/_topics';
import { signupRoutes } from '@/auth/signupRoutes';
import { federatedOriginOf, federationEnabled } from '@/auth/federation';
import { FEDERATION_COOKIE, openFederationOrigins } from '@/auth/federationCookie';
import { authRoutes } from '@/auth/routes';
import { logger } from '@/logger';
import { env, TRUST_PROXY } from '@/Utils/Env';
import { registerWS } from '@/ws/handler';
import {
    createModuleServices,
    isModulePublicPath,
    keepRawBody,
    moduleAgentHooks,
    modulePublicRoutes,
    moduleServiceControl,
    parseFormFields,
    startModuleServices,
    stopModuleServices
} from '@/features/_sdk/register';
import { setSdkHost } from '@/features/_sdk/host';
import { createPlanPausesService } from '@/features/_planPauses';
import { createAuditLog } from '@/Services/AuditLog';
import { startAttemptSweeper } from '@/Services/attempts';
import { startDekSweeper } from '@/Services/SecureStore';
import { registerProxyRoute } from '@/Services/domains/proxy';
import { createDomainVerifier } from '@/Services/domains/verifier';
import { createLogRetention } from '@/Services/logRetention';
import { createMailer } from '@/Services/mailer';
import { createSignupService } from '@/Services/signup';
import { maintenance, MaintenanceError } from '@/Services/maintenance';
import { describeError, systemAlerts } from '@/Services/systemAlerts';
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
 *
 * `blob:` en `media-src` et `frame-src` sert l'aperçu d'un fichier choisi sur le
 * poste (vidéo, son, PDF), lu sans être envoyé. Une adresse `blob:` ne se
 * fabrique que par un script de l'origine : qui n'a qu'une injection HTML n'en
 * obtient aucune, et le document ainsi encadré hérite de cette politique,
 * `script-src` compris.
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
        'media-src': ["'self'", 'blob:'],
        'frame-src': ["'self'", 'blob:'],
        'worker-src': ["'self'", 'blob:'],
        'frame-ancestors': ["'none'"],
        'base-uri': ["'none'"],
        'object-src': ["'none'"],
        'form-action': ["'self'"]
    }
} as const;

/**
 * Ce qu'une page fédérée atteint en HTTP : de quoi ouvrir et tenir sa session,
 * et les routes HTTP que le client appelle hors socket. Une liste fermée : le
 * reste de `/api` ne répond qu'à notre page.
 */
const FEDERATED_PATHS = new Set([
    '/api/status',
    '/api/auth/login',
    '/api/auth/2fa/challenge',
    '/api/auth/2fa/cancel',
    '/api/auth/refresh',
    '/api/auth/logout',
    '/api/auth/me',
    '/api/auth/change-password',
    '/api/auth/ws-ticket',
    '/api/agent/targets'
]);
const FEDERATED_PREFIXES = ['/api/agent/download/'];

function isFederatedPath(url: string): boolean {
    const end = url.indexOf('?');
    const path = end === -1 ? url : url.slice(0, end);
    return FEDERATED_PATHS.has(path) || FEDERATED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/** `https://hôte` et sa socket `wss://hôte` : les deux formes que `connect-src` distingue. */
function connectSourcesOf(origin: string): string[] {
    return [origin, origin.replace(/^http/, 'ws')];
}

/**
 * La politique de contenu d'un document dont le compte a des instances
 * distantes : celle de tout le monde, `connect-src` élargi à elles seules. La
 * politique d'un document est figée à son chargement, d'où le rechargement que
 * le client fait après un ajout.
 */
export function documentCsp(remoteOrigins: readonly string[]): string {
    return Object.entries(CONTENT_SECURITY_POLICY.directives)
        .map(([name, values]) => {
            const sources: string[] =
                name === 'connect-src' ? [...values, ...remoteOrigins.flatMap(connectSourcesOf)] : [...values];
            return `${name} ${sources.join(' ')}`;
        })
        .join(';');
}

export interface AppDeps {
    db: Database;
    crypt: Encryption;
}

export interface BuiltApp {
    app: FastifyInstance;
    /** Les services de fond, démarrés ici : leur arrêt, par index.ts. */
    stopServices(): Promise<PromiseSettledResult<void>[]>;
}

export async function buildApp(deps: AppDeps): Promise<BuiltApp> {
    const app = Fastify({
        loggerInstance: logger as FastifyBaseLogger,
        trustProxy: TRUST_PROXY,
        requestTimeout: env.REQUEST_TIMEOUT_SECONDS * 1000
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
        // La page d'une instance fédérée : lisible par elle, jamais avec les
        // cookies, son jeton voyageant en `Authorization`.
        const federated = federatedOriginOf(req);
        if (federated && isFederatedPath(req.url ?? '')) {
            callback(null, {
                origin: federated,
                credentials: false,
                methods: ['GET', 'POST'],
                allowedHeaders: ['Content-Type', 'Authorization']
            });
            return;
        }
        callback(null, { origin: env.PUBLIC_ORIGIN, credentials: true, methods: ['GET', 'POST'] });
    });
    // Une instance auto-hébergée vit souvent sur une adresse privée, et la page
    // qui la fédère sur une adresse publique : Chrome fait précéder cet appel
    // d'un prévol qui exige cet en-tête, que `@fastify/cors` ne sait pas poser.
    app.addHook('onSend', async (req, reply) => {
        if (req.headers['access-control-request-private-network'] === 'true' && federatedOriginOf(req)) {
            reply.header('Access-Control-Allow-Private-Network', 'true');
        }
    });
    await app.register(fastifyCookie);
    // Tout ce qui n'est ni l'API ni la socket est le client, document compris :
    // c'est sa réponse qui porte la politique sous laquelle la page vivra.
    app.addHook('onSend', async (req, reply) => {
        if (req.method !== 'GET' || req.url.startsWith('/api') || req.url.startsWith('/ws')) return;
        // Une page publique de module pose sa propre politique.
        if (isModulePublicPath(req.url)) return;
        const remoteOrigins = openFederationOrigins(req.cookies[FEDERATION_COOKIE]);
        if (remoteOrigins.length > 0) reply.header('content-security-policy', documentCsp(remoteOrigins));
    });
    await app.register(fastifyRateLimit, {
        max: env.RATE_LIMIT_MAX,
        timeWindow: env.RATE_LIMIT_WINDOW
    });
    await app.register(fastifyWebsocket, { options: { maxPayload: WS_MAX_PAYLOAD } });

    // Tolerate empty JSON bodies: cookie-based POSTs (e.g. /api/auth/refresh,
    // /api/auth/logout) send `Content-Type: application/json` with no body, which
    // Fastify 5 rejects by default (FST_ERR_CTP_EMPTY_JSON_BODY).
    app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
        if (!body) {
            done(null, undefined);
            return;
        }
        keepRawBody(req, body as string);
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
        if (error instanceof MaintenanceError) {
            return reply.code(503).header('Retry-After', '300').send(err('maintenance', error.message));
        }
        const explicit = typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500;
        const status = explicit ? (error.statusCode as number) : 500;
        if (status >= 500) {
            req.log.error({ err: error }, 'unhandled request error');
            const route = `${req.method} ${req.routeOptions.url ?? req.url.split('?')[0]}`;
            systemAlerts.report({
                key: `http:${route}`,
                level: 'error',
                title: 'Erreur serveur sur une requête HTTP',
                detail: `${route}\n${describeError(error)}`
            });
        } else {
            // Un refus ordinaire (saisie invalide, droit manquant) : ni `err` ni
            // le mot « error », qui le feraient passer pour une panne à la lecture.
            req.log.info({ status, code: error.code, reason: error.message }, 'Request rejected');
        }
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
    // sait produire. Le décodage et son plafond de paires sont partagés avec
    // l'écouteur public : c'est une borne, elle ne se tient pas à deux endroits.
    app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
        if (!body) {
            done(null, undefined);
            return;
        }
        done(null, parseFormFields(body as string));
    });

    app.get('/api/health', { logLevel: 'silent' }, async () => ({ ok: true }));

    // Boot/deployment readiness (agent sync + future steps). Public + cheap so
    // the client can show a discreet topbar zone until the server is fully ready.
    app.get('/api/status', { logLevel: 'silent' }, async () =>
        ok(serverStatusSchema.parse({ ...status.snapshot(), federation: federationEnabled() }))
    );

    // Ce que la page de maintenance d'un visiteur sans session peut savoir.
    app.get('/api/maintenance', { logLevel: 'silent' }, async () =>
        ok(publicMaintenanceSchema.parse(maintenance.publicState()))
    );

    registerProxyRoute(app, deps.db.featureDomains);

    const hub = new MonitorHub();
    // Construit avant les services de fond : ils lui adressent leurs changements
    // (ils écrivent sans commande utilisateur, donc sans socket pour diffuser).
    const live = new LiveHub();
    // La diffusion traverse les projections : un espace est prévenu des
    // écritures faites chez ceux qui partagent avec lui, dans les deux sens.
    live.setShareLinks((workspaceId, feature) => deps.db.itemSharing.linkedWorkspaces(workspaceId, feature));
    live.startHeartbeat();
    startDekSweeper();
    startAttemptSweeper();
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
    const mailer = createMailer({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        user: env.SMTP_USER,
        password: env.SMTP_PASSWORD,
        from: env.SMTP_FROM
    });
    const signup = createSignupService({
        db: deps.db,
        mailer,
        logger,
        mode: env.SIGNUP_MODE,
        origin: env.PUBLIC_ORIGIN.replace(/\/+$/, '')
    });
    createModuleServices({ db: deps.db, crypt: deps.crypt, audit, logger, live, mailer });
    const hostServices = [
        createDomainVerifier({ db: deps.db, crypt: deps.crypt, logger, live }),
        signup,
        createLogRetention({ db: deps.db, logger })
    ];
    // Lue avant tout démarrage : un service en arrêt complet ne démarre pas, et
    // `MAINTENANCE=1` ferme le site avant la première connexion.
    await maintenance.init({ db: deps.db, live, logger, services: moduleServiceControl });
    // Avant les modules : leur premier tour lit déjà ce que l'offre tient en pause.
    const planPauses = createPlanPausesService({ db: deps.db, logger, live });
    await planPauses.start();
    await startModuleServices((featureId) => maintenance.featureLevel(featureId) === 'full');
    for (const svc of hostServices) await svc.start();
    const stopServices = async (): Promise<PromiseSettledResult<void>[]> => {
        await maintenance.close();
        const [modules, host] = await Promise.all([
            stopModuleServices(),
            Promise.allSettled([...hostServices, planPauses].map(async (svc) => svc.stop()))
        ]);
        return [...modules, ...host];
    };

    await authRoutes(app, { db: deps.db, crypt: deps.crypt, audit, live });
    await signupRoutes(app, { db: deps.db, audit, live, signup });
    await agentRoutes(app, { db: deps.db, hub, live, audit });
    // Routes publiques des modules (capacité `routes.public`), aussi montées
    // sur la surface publique quand elle existe (`publicApp.ts`). Après la
    // création des services, qui les déclarent.
    await modulePublicRoutes(app, 'app');
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
            // La racine est une route (`modulePublicRoutes`), qui retombe sur le
            // repli ci-dessous hors d'un domaine client.
            index: false,
            allowedPath: (pathName) => !pathName.endsWith('.map')
        });

        // Le manifeste de build, ce qu'un contrôle d'intégrité d'une autre
        // instance relit. Une route à part : `@fastify/static` tait les dossiers
        // cachés, et `.well-known` en est un ; le repli SPA lui répondrait la page.
        const manifestFile = resolve(clientDir, '.well-known', 'deveye-build.json');
        if (existsSync(manifestFile)) {
            const manifest = readFileSync(manifestFile, 'utf8');
            app.get(BUILD_MANIFEST_PATH, { logLevel: 'silent' }, async (_req, reply) =>
                reply.type('application/json').send(manifest)
            );
        }

        // SPA fallback: any non-API/WS GET that didn't match a static asset
        // returns index.html so client-side routing can take over. Les cartes de
        // source du build ne sortent jamais : elles portent le code commenté.
        app.setNotFoundHandler((req, reply) => {
            if (req.url.endsWith('.map')) return reply.code(404).send({ error: 'not_found' });
            const page = req.method === 'GET' || req.method === 'HEAD';
            if (page && !req.url.startsWith('/api') && !req.url.startsWith('/ws')) {
                return reply.sendFile('index.html');
            }
            return reply.code(404).send({ error: 'not_found' });
        });
    } else {
        app.log.debug({ clientDir }, 'No client build found; static serving disabled (host dev uses Vite)');
    }

    return { app, stopServices };
}
