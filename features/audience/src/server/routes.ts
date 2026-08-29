import { audienceEventInputSchema, audienceIngestSchema } from '../contracts/domain';
import type { SdkPublicApp, SdkPublicReply, SdkPublicRequest } from '@deveye/types/sdk/server';

import { TRACKER_SCRIPT, TRACKER_SCRIPT_ETAG } from './script';
import type { AudienceIngest, IngestRequest } from './service';

/**
 * La porte publique de DevEye, la seule : tout le reste du serveur suppose une
 * session, un cookie ou un jeton d'appareil. Ces trois routes sont appelées par
 * des navigateurs qui ne savent rien de DevEye, depuis des sites qui ne lui
 * appartiennent pas. D'où :
 *
 * 1. elles répondent toujours `204`, quel que soit le motif du refus : un
 *    endpoint public qui distingue ses refus dit à qui le sonde quelles clés
 *    existent, et laquelle vient d'être révoquée ;
 * 2. elles n'attendent pas la base, `accept()` range en mémoire et rend la main ;
 * 3. elles ont leur propre plafond de débit, celui du serveur étant dimensionné
 *    pour une interface humaine.
 *
 * Leur CORS est ouvert à toute origine, et ce n'est pas un relâchement : la
 * protection est la liste d'origines par site, appliquée côté serveur où le
 * client ne peut pas mentir, et non un en-tête que le navigateur s'applique.
 *
 * Le corps arrive déjà décodé par les analyseurs de l'hôte, un corps illisible
 * valant `undefined`, que la validation zod écarte comme le reste.
 */

/**
 * Le plafond, par IP. Généreux parce qu'il borne un visiteur et non un site.
 * La clé du site n'y entre pas : le plafond s'applique avant l'analyse du
 * corps, donc elle n'est pas encore connue.
 */
const INGEST_RATE_LIMIT = { max: 600, timeWindow: '1 minute' };

/**
 * Rendre une réponse chargeable depuis une autre origine : helmet pose
 * `Cross-Origin-Resource-Policy: same-origin` sur tout le reste, ce qui est le
 * bon défaut pour une application mais pas pour ces routes.
 *
 * CORP n'est pas CORS et sa panne ne ressemble à rien de connu : le serveur
 * répond `200`, la réponse arrive complète, puis le navigateur la jette avec
 * `ERR_BLOCKED_BY_RESPONSE.NotSameOrigin`, sans qu'aucun en-tête CORS soit en
 * cause. C'est le cas d'un `<script src>`, la façon dont une page tierce charge
 * `/t.js`. Posé aussi sur l'ingestion par précaution, ses requêtes étant en
 * mode `cors` aujourd'hui mais rien ne le garantit d'un client futur.
 */
function allowCrossOrigin(reply: SdkPublicReply): void {
    reply.header('Cross-Origin-Resource-Policy', 'cross-origin');
}

export function audienceRoutes(app: SdkPublicApp, ingest: AudienceIngest): void {
    /**
     * Le script de mesure, hors de `/api` volontairement : c'est cette adresse
     * qu'on colle dans une page. Le repli SPA ne l'attrape pas, une route
     * déclarée l'emporte sur le gestionnaire de 404.
     */
    app.get('/t.js', {}, async (req, reply) => {
        allowCrossOrigin(reply);
        reply.header('Content-Type', 'application/javascript; charset=utf-8');
        // Une heure : assez pour que la balise ne coûte rien à la visite suivante,
        // assez peu pour qu'un correctif se propage dans la journée.
        reply.header('Cache-Control', 'public, max-age=3600');
        reply.header('ETag', TRACKER_SCRIPT_ETAG);
        if (req.headers['if-none-match'] === TRACKER_SCRIPT_ETAG) return reply.code(304).send();
        return reply.send(TRACKER_SCRIPT);
    });

    /** Un lot d'événements : la voie normale, celle qu'emprunte le script. */
    app.post('/api/t/b', { rateLimit: INGEST_RATE_LIMIT }, async (req, reply) => {
        allowCrossOrigin(reply);
        const parsed = audienceIngestSchema.safeParse(req.body);
        if (parsed.success) {
            await submit(req, ingest, parsed.data.key, parsed.data.events, parsed.data.visitorId ?? null);
        }
        return reply.code(204).send();
    });

    /**
     * Un événement isolé. Le script ne s'en sert pas, il groupe toujours : elle
     * existe pour ce qui n'a pas de file d'attente, un `curl` de vérification,
     * un appel depuis un serveur, un client minimal.
     */
    app.post('/api/t/e', { rateLimit: INGEST_RATE_LIMIT }, async (req, reply) => {
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

async function submit(
    req: SdkPublicRequest,
    ingest: AudienceIngest,
    key: string,
    events: IngestRequest['events'],
    visitorId: string | null
): Promise<void> {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : null;
    const userAgent = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : '';
    await ingest.accept({ key, visitorId, origin, ip: req.ip, userAgent, events });
}
