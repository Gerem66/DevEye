import { audienceEventInputSchema, audienceIngestSchema } from 'deveye-types';
import type { FastifyInstance, FastifyReply } from 'fastify';

import type { AudienceIngest } from '@/Services/AudienceIngest';
import { TRACKER_SCRIPT, TRACKER_SCRIPT_ETAG } from './script';

/**
 * La porte publique de DevEye — la seule.
 *
 * Tout le reste du serveur suppose une session, un cookie ou un jeton
 * d'appareil. Ces trois routes-ci sont appelées par des navigateurs qui ne
 * savent rien de DevEye, depuis des sites qui ne lui appartiennent pas, sans
 * personne derrière. Trois conséquences les façonnent :
 *
 * 1. **Elles répondent toujours `204`.** Clé inconnue, origine refusée, site
 *    éteint, charge utile invalide : la réponse est la même. Un endpoint public
 *    qui distingue ses refus est un oracle — il dirait à qui le sonde quelles
 *    clés existent, et laquelle vient d'être révoquée.
 * 2. **Elles n'attendent pas la base.** `accept()` range en mémoire et rend la
 *    main ; l'écriture a lieu une fois par seconde, en lot (voir
 *    `Services/AudienceIngest.ts`).
 * 3. **Elles ont leur propre plafond de débit.** Celui du serveur (200/min) est
 *    dimensionné pour une interface humaine et couperait un site un peu
 *    fréquenté au bout de trois visiteurs.
 *
 * ⚠️ Le CORS de ces routes est ouvert à toute origine, par le délégateur
 * installé dans `app.ts`. Ce n'est pas un relâchement : la protection est la
 * liste d'origines **par site**, appliquée côté serveur où le client ne peut
 * pas mentir, et non un en-tête que le navigateur applique pour lui-même.
 */

interface AudienceRouteDeps {
    ingest: AudienceIngest;
}

/**
 * Le plafond, par IP.
 *
 * Généreux, parce qu'il borne un **visiteur** et non un site : 600 par minute
 * laisse passer une navigation soutenue et arrête une boucle. La clé du site
 * n'y entre pas — le plafond est appliqué avant que le corps ne soit analysé,
 * donc elle n'est pas encore connue à ce moment-là.
 */
const INGEST_RATE_LIMIT = { max: 600, timeWindow: '1 minute' };

/**
 * Rendre une réponse chargeable depuis une **autre** origine.
 *
 * `@fastify/helmet` pose `Cross-Origin-Resource-Policy: same-origin` sur tout
 * ce que le serveur renvoie, et c'est le bon défaut pour une application. Mais
 * ces trois routes-ci existent précisément pour être atteintes d'ailleurs.
 *
 * ⚠️ **CORP n'est pas CORS, et sa panne ne ressemble à rien de connu.** Le
 * serveur répond `200`, la réponse arrive complète, puis le navigateur la jette
 * et écrit `ERR_BLOCKED_BY_RESPONSE.NotSameOrigin` — aucun en-tête CORS n'est en
 * cause, et les régler mieux n'y change rien. C'est le cas d'un `<script src>`
 * (requête `no-cors`, où CORP est appliqué), qui est exactement la façon dont
 * une page tierce charge `/t.js`.
 *
 * Posé aussi sur l'ingestion, par précaution : ses requêtes sont en mode `cors`
 * — donc hors du champ de CORP aujourd'hui — mais rien ne garantit qu'un client
 * futur, natif ou non, les émettra de la même façon.
 */
function allowCrossOrigin(reply: FastifyReply): void {
    reply.header('Cross-Origin-Resource-Policy', 'cross-origin');
}

export async function audienceRoutes(app: FastifyInstance, { ingest }: AudienceRouteDeps): Promise<void> {
    /**
     * Le script de mesure.
     *
     * Hors de `/api` volontairement : c'est cette adresse-là qu'on colle dans
     * une page, et `/t.js` se retient. Le repli SPA ne l'attrape pas — une
     * route déclarée l'emporte toujours sur le gestionnaire de 404.
     */
    app.get('/t.js', { logLevel: 'silent' }, async (req, reply) => {
        allowCrossOrigin(reply);
        reply.header('Content-Type', 'application/javascript; charset=utf-8');
        // Une heure : assez pour que la balise ne coûte rien à la visite
        // suivante, assez peu pour qu'un correctif se propage dans la journée.
        reply.header('Cache-Control', 'public, max-age=3600');
        reply.header('ETag', TRACKER_SCRIPT_ETAG);
        if (req.headers['if-none-match'] === TRACKER_SCRIPT_ETAG) return reply.code(304).send();
        return reply.send(TRACKER_SCRIPT);
    });

    /** Un lot d'événements — la voie normale, celle qu'emprunte le script. */
    app.post('/api/t/b', { logLevel: 'silent', config: { rateLimit: INGEST_RATE_LIMIT } }, async (req, reply) => {
        allowCrossOrigin(reply);
        const parsed = audienceIngestSchema.safeParse(req.body);
        if (parsed.success) {
            await submit(req, ingest, parsed.data.key, parsed.data.events, parsed.data.visitorId ?? null);
        }
        return reply.code(204).send();
    });

    /**
     * Un événement isolé.
     *
     * Le script ne s'en sert pas — il groupe toujours. Elle existe pour ce qui
     * n'a pas de file d'attente : une commande `curl` de vérification, un
     * appel depuis un serveur, un client minimal qu'on écrit en dix lignes.
     */
    app.post('/api/t/e', { logLevel: 'silent', config: { rateLimit: INGEST_RATE_LIMIT } }, async (req, reply) => {
        allowCrossOrigin(reply);
        const body = req.body as { key?: unknown } | undefined;
        const key = typeof body?.key === 'string' ? body.key : '';
        const parsed = audienceEventInputSchema.safeParse(req.body);
        if (key && parsed.success) {
            await submit(req, ingest, key, [parsed.data], parsed.data.visitorId ?? null);
        }
        return reply.code(204).send();
    });
}

/** Le peu qu'il reste à faire une fois la charge utile validée. */
async function submit(
    req: { headers: Record<string, unknown>; ip: string },
    ingest: AudienceIngest,
    key: string,
    events: Parameters<AudienceIngest['accept']>[0]['events'],
    visitorId: string | null
): Promise<void> {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : null;
    const userAgent = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : '';
    await ingest.accept({ key, visitorId, origin, ip: req.ip, userAgent, events });
}
