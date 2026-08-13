import fastifyCors from '@fastify/cors';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyBaseLogger, type FastifyError, type FastifyInstance } from 'fastify';
import { err, type ErrorCode } from 'deveye-types';

import { audienceRoutes } from '@/audience/routes';
import { logger } from '@/logger';
import { env, isDev } from '@/Utils/Env';
import type { AudienceIngest } from '@/Services/AudienceIngest';

/**
 * Le serveur **public** : un second écouteur, sur son propre port, qui ne porte
 * que ce qui a le droit d'être atteint depuis Internet.
 *
 * ## Pourquoi un second écouteur plutôt qu'une garde
 *
 * L'application vit derrière le VPN ; l'ingestion d'audience doit être joignable
 * sans lui. On peut obtenir cela de trois façons, et deux sont moins sûres :
 *
 * - **une règle de chemin dans le proxy** : elle vit hors du dépôt, se perd à un
 *   redéploiement, et rien dans le code ne dit qu'elle est indispensable ;
 * - **une garde sur l'en-tête `Host`** dans le serveur unique : les routes
 *   internes restent *déclarées*, et seul un `if` les sépare du monde. Un défaut
 *   dans ce `if`, ou un accès direct au conteneur, et tout est atteignable.
 * - **un écouteur séparé** : les routes internes n'y sont **pas enregistrées**.
 *   Il n'existe aucun chemin de code de ce port vers l'authentification, la
 *   socket, la flotte d'appareils ou le client web. La séparation ne dépend
 *   d'aucune configuration.
 *
 * C'est la troisième, et c'est ce qui explique tout ce que ce fichier ne fait
 * pas : ni cookies, ni WebSocket, ni fichiers statiques, ni repli SPA.
 *
 * ## Pourquoi le **même processus**
 *
 * Ce n'est pas un confort, c'est une contrainte. `AudienceIngest` prévient les
 * écrans ouverts par `LiveHub`, dont l'état est **local au processus** (voir
 * LIVE.md §6). Un second conteneur écrirait donc les mesures sans que personne
 * ne soit averti : le rafraîchissement à la minute cesserait de fonctionner,
 * silencieusement. Partager le processus, c'est partager la file d'ingestion,
 * les caches de sites et de libellés, et le hub.
 *
 * ## Ce qui est volontairement dupliqué depuis `app.ts`
 *
 * Le harnais (helmet, plafond de débit, analyseur `text/plain`, gestionnaire
 * d'erreurs) est réécrit ici plutôt que partagé. Les deux serveurs appliquent
 * des **politiques différentes** sur les mêmes plugins — un CORS ouvert à tous
 * ici, restreint et porteur de cookies là-bas — et une fabrique commune
 * paramétrée aurait rendu difficile à lire ce qui doit rester évident : ce port
 * n'expose rien d'autre.
 */
export interface PublicAppDeps {
    ingest: AudienceIngest;
}

export async function buildPublicApp({ ingest }: PublicAppDeps): Promise<FastifyInstance> {
    const app = Fastify({
        loggerInstance: logger.child({ surface: 'public' }) as FastifyBaseLogger,
        // Indispensable, et pas seulement cosmétique : le plafond de débit
        // compte par IP. Sans cela il verrait celle du proxy, et le premier
        // visiteur un peu actif fermerait la porte à tous les autres.
        trustProxy: !isDev
    });

    await app.register(fastifyHelmet, { contentSecurityPolicy: false });

    // Tout ce que ce port sert est fait pour être chargé depuis ailleurs : pas
    // de délégateur ici, contrairement à `app.ts`. **Sans identifiants** — il
    // n'y a aucune session à transporter, et l'annoncer ferme la porte à une
    // erreur de configuration future.
    await app.register(fastifyCors, { origin: '*', credentials: false, methods: ['GET', 'POST'] });

    await app.register(fastifyRateLimit, {
        max: env.RATE_LIMIT_MAX,
        timeWindow: env.RATE_LIMIT_WINDOW
    });

    // `text/plain` porteur de JSON : la forme qu'émet `navigator.sendBeacon`
    // sans déclencher de requête préalable OPTIONS. Un corps illisible rend
    // `undefined`, que la validation zod de l'ingestion écarte comme le reste.
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

    /**
     * Une sonde de vivacité, et rien d'autre.
     *
     * Elle ne dit ni la version, ni l'état de la base, ni l'avancement du
     * démarrage : `/api/status` reste sur le port privé. Un orchestrateur a
     * besoin de savoir que le port répond, pas de ce qu'il y a derrière.
     */
    app.get('/api/health', { logLevel: 'silent' }, async () => ({ ok: true }));

    await audienceRoutes(app, { ingest });

    // Pas de repli SPA : tout ce qui n'est pas déclaré ci-dessus n'existe pas.
    // C'est la différence avec `app.ts`, où un GET inconnu rend `index.html`.
    app.setNotFoundHandler((_req, reply) => reply.code(404).send(err('not_found', 'Introuvable')));

    return app;
}
