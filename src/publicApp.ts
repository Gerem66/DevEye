import fastifyCors from '@fastify/cors';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyBaseLogger, type FastifyError, type FastifyInstance } from 'fastify';
import { err, type ErrorCode } from '@deveye/types';

import { keepRawBody, modulePublicRoutes, parseFormFields } from '@/features/_sdk/register';
import { logger } from '@/logger';
import { env, TRUST_PROXY } from '@/Utils/Env';

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
/**
 * Signale, une fois, un `TRUST_PROXY` qui ne colle pas à la chaîne réelle.
 *
 * Tout ce qui borne par adresse sur ce port en dépend : les plafonds de débit,
 * les quotas par provenance, les mises à l'écart. Avec un saut de trop devant
 * (un CDN ajouté au-dessus du proxy), `req.ip` devient l'adresse de ce dernier
 * et **le monde entier se rabat sur une seule clé** : un visiteur actif ferme
 * alors la porte à tous les autres. Rien dans le code ne peut deviner la
 * topologie, mais un `X-Forwarded-For` plus long que le nombre de sauts
 * accordés la trahit à coup sûr.
 *
 * Le contrôle ne vaut que pour la forme numérique : en liste d'adresses, c'est
 * proxy-addr qui tranche et le compte des sauts ne dit plus rien.
 */
function warnOnProxyMismatch(app: FastifyInstance): void {
    const hops = /^\d+$/.test(env.TRUST_PROXY.trim()) ? Number(env.TRUST_PROXY.trim()) : null;
    if (hops === null) return;
    let warned = false;
    app.addHook('onRequest', async (req) => {
        if (warned) return;
        const forwarded = req.headers['x-forwarded-for'];
        if (typeof forwarded !== 'string') return;
        const chain = forwarded.split(',').filter((part) => part.trim().length > 0).length;
        if (chain <= hops) return;
        warned = true;
        req.log.warn(
            { chain, hops, seen: req.ip },
            'TRUST_PROXY est plus court que la chaîne réelle : toutes les bornes par adresse comptent la même'
        );
    });
}

export async function buildPublicApp(): Promise<FastifyInstance> {
    const app = Fastify({
        loggerInstance: logger.child({ surface: 'public' }) as FastifyBaseLogger,
        // Le plafond de débit compte par IP : sans cela il verrait celle du
        // proxy, et un seul visiteur actif fermerait la porte à tous.
        trustProxy: TRUST_PROXY,
        // Ce port ne sert que des corps minuscules, et il est exposé : à défaut
        // de délai, un corps envoyé au compte-gouttes immobilise une socket
        // jusqu'aux cinq minutes de Node, pour le prix d'un octet de temps en
        // temps. L'écouteur applicatif garde le sien, long par nécessité (les
        // téléversements), mais il vit derrière le VPN.
        requestTimeout: 15_000,
        // Un filet sous les plafonds que chaque route déclare : ce qui n'en a
        // pas n'a aucune raison d'être gros non plus.
        bodyLimit: 256 * 1024
    });

    // Aucune page servie ici, seulement des routes de données : tout est fermé.
    await app.register(fastifyHelmet, {
        contentSecurityPolicy: { useDefaults: false, directives: { 'default-src': ["'none'"] } }
    });

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

    app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
        if (!body) {
            done(null, undefined);
            return;
        }
        keepRawBody(req, body as string);
        try {
            done(null, JSON.parse(body as string));
        } catch {
            done(null, undefined);
        }
    });

    // `application/x-www-form-urlencoded` : ce qu'émet un `<form method="post">`
    // sans une ligne de JavaScript, la seule forme qu'un site vraiment statique
    // sait produire. Le décodage et son plafond de paires sont partagés avec
    // l'écouteur applicatif : c'est une borne, elle ne se tient pas à deux endroits.
    app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
        if (!body) {
            done(null, undefined);
            return;
        }
        done(null, parseFormFields(body as string));
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

    warnOnProxyMismatch(app);

    // Sonde de vivacité seulement : ni version ni état de la base, `/api/status`
    // reste sur le port privé.
    app.get('/api/health', { logLevel: 'silent' }, async () => ({ ok: true }));

    await modulePublicRoutes(app, 'public');

    // Pas de repli SPA : tout ce qui n'est pas déclaré ci-dessus n'existe pas.
    // C'est la différence avec `app.ts`, où un GET inconnu rend `index.html`.
    app.setNotFoundHandler((_req, reply) => reply.code(404).send(err('not_found', 'Introuvable')));

    return app;
}
