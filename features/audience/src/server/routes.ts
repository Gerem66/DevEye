import { audienceEventInputSchema, audienceIngestSchema, audienceSubmitSchema } from '../contracts/domain';
import type { SdkPublicApp, SdkPublicReply, SdkPublicRequest } from '@deveye/types/sdk/server';

import { normalizeHost } from './normalize';
import { TRACKER_SCRIPT, TRACKER_SCRIPT_ETAG } from './script';
import type { AudienceIngest, IngestRequest, SubmitOutcome } from './service';

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
 *
 * `/api/t/s` s'écarte un peu de la règle 1 : un corps qui ne ressemble à rien
 * rend `400`. Ce n'est pas un renseignement sur les clés qui existent, c'est
 * une propriété de la requête envoyée, et sans cela une intégration mal écrite
 * n'aurait aucun moyen de se voir.
 */

/**
 * Le plafond, par IP. Généreux parce qu'il borne un visiteur et non un site.
 * La clé du site n'y entre pas : le plafond s'applique avant l'analyse du
 * corps, donc elle n'est pas encore connue.
 */
const INGEST_RATE_LIMIT = { max: 600, timeWindow: '1 minute' };

/**
 * Le plafond des retours, bien plus serré : une requête de mesure range un
 * entier dans une file, une requête de retour écrit une ligne et chiffre. Trente
 * par minute laisse largement passer un humain qui se reprend, et ferme la porte
 * à un robot qui insiste.
 */
const SUBMIT_RATE_LIMIT = { max: 30, timeWindow: '1 minute' };

/**
 * Les champs réservés d'un envoi de formulaire HTML. Le tiret bas les distingue
 * des réponses, qu'un site nomme comme il veut : sans préfixe, un formulaire
 * dont une question s'appellerait « form » perdrait sa réponse.
 */
const RESERVED_FIELDS = new Set(['_key', '_form', '_next', '_hp', '_path']);

/**
 * La page de remerciement de dernier recours : celle qu'on sert quand le site
 * n'a pas dit où renvoyer, ou l'a dit vers un ailleurs. Volontairement nue et
 * sans marque : c'est le visiteur d'un autre site qui la voit.
 */
const RETRY_PAGE = `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Envoi impossible</title>
<style>body{font:16px/1.6 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh}
p{max-width:32rem;padding:2rem;text-align:center}</style></head>
<body><p>Votre message n'a pas pu être enregistré. Merci de réessayer dans un instant.</p></body></html>`;

const THANK_YOU_PAGE = `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Merci</title>
<style>body{font:16px/1.6 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh}
p{max-width:32rem;padding:2rem;text-align:center}</style></head>
<body><p>Merci, votre message a bien été envoyé. Vous pouvez fermer cette page.</p></body></html>`;

/**
 * Ce que voit le visiteur d'un `<form>` dont l'envoi ne colle pas au formulaire
 * déclaré. Personne n'est là pour lire un JSON d'erreur, et un renvoi silencieux
 * vers la page de remerciement lui ferait croire que son message est parti.
 *
 * Le nom du champ est échappé : il vient de la requête, et le recopier tel quel
 * dans du HTML servi à un tiers serait une injection offerte.
 */
function invalidPage(field: string): string {
    return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Envoi refusé</title>
<style>body{font:16px/1.6 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh}
p{max-width:32rem;padding:2rem;text-align:center}code{font-family:ui-monospace,monospace}</style></head>
<body><p>Votre message n'a pas été enregistré : le champ <code>${escapeHtml(field)}</code> ne correspond pas
à ce que ce formulaire attend.</p></body></html>`;
}

/**
 * Le champ que zod a refusé, nommé comme le site l'a écrit dans son `<form>` :
 * les réservés reprennent leur tiret bas, une réponse garde son nom. Sans cette
 * traduction, l'écran parlerait de `key` là où la page porte `_key`.
 */
function htmlFieldOf(error: { issues: readonly { path: readonly PropertyKey[] }[] }): string {
    const path = error.issues[0]?.path ?? [];
    const [head, next] = path;
    if (head === 'fields') return String(next ?? 'inconnu');
    if (typeof head === 'string') return `_${head}`;
    return 'inconnu';
}

function escapeHtml(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

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
            await acceptEvents(req, ingest, parsed.data.key, parsed.data.events, parsed.data.visitorId ?? null);
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
            await acceptEvents(req, ingest, key, [parsed.data], parsed.data.visitorId ?? null);
        }
        return reply.code(204).send();
    });

    /**
     * Un retour. Deux formes de corps, parce qu'un site statique doit pouvoir
     * s'en servir des deux façons : le JSON qu'envoie `deveye.submit` (ou un
     * `curl`, ou un serveur), et le `application/x-www-form-urlencoded` d'un
     * `<form method="post">` sans une ligne de JavaScript. La seconde se
     * reconnaît à son `_key`, et l'analyseur de l'hôte a déjà fait le décodage.
     */
    app.post('/api/t/s', { rateLimit: SUBMIT_RATE_LIMIT }, async (req, reply) => {
        allowCrossOrigin(reply);
        // Un `_key` à la racine signe un envoi de formulaire HTML : ses champs
        // arrivent à plat, là où le JSON les range sous `fields`.
        const body = (req.body ?? {}) as Record<string, unknown>;
        const html = typeof body._key === 'string';
        const parsed = audienceSubmitSchema.safeParse(html ? fromHtmlForm(body) : req.body);

        // Un pot de miel rempli est un robot : on accepte sans rien écrire, pour
        // qu'il ne sache pas qu'il a été vu et n'essaie pas autre chose.
        const trapped = html && typeof body._hp === 'string' && body._hp.trim().length > 0;
        let outcome: SubmitOutcome = { status: 'ignored' };
        if (parsed.success && !trapped) {
            const origin = typeof req.headers.origin === 'string' ? req.headers.origin : null;
            const userAgent = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : '';
            outcome = await ingest.submit({
                key: parsed.data.key,
                form: parsed.data.form,
                fields: parsed.data.fields,
                path: parsed.data.path ?? null,
                visitorId: parsed.data.visitorId ?? null,
                origin,
                ip: req.ip,
                userAgent
            });
        }

        if (!html) {
            // Le seul refus qu'on nomme : la forme du corps, qui ne dit rien des
            // clés qui existent et sans quoi une intégration fautive resterait muette.
            if (!parsed.success) return reply.code(400).send({ ok: false });
            // Un envoi qui ne colle pas au schéma déclaré est du même ordre : c'est
            // la requête qui cloche, et le seul renseignement que ce refus donne est
            // « cette clé existe », alors qu'elle est publique dans la page. Sans
            // lui, un site qui vient de renommer un champ n'aurait aucun moyen de
            // s'en apercevoir.
            if (outcome.status === 'invalid') {
                return reply.code(400).send({ ok: false, field: outcome.field, reason: outcome.reason });
            }
            // Une panne s'avoue, elle aussi : répondre « reçu » sur une écriture
            // qui a échoué ferait annoncer au visiteur un message perdu. Le mince
            // renseignement que cela donne à qui sonde ne vaut que le temps de la
            // panne, et il n'y a alors pas grand-chose d'autre qui tienne debout.
            if (outcome.status === 'failed') return reply.code(503).send({ ok: false });
            return reply.send({ ok: true });
        }

        // Un corps que zod refuse nomme son champ, il ne remercie pas : sans quoi
        // une clé mal recopiée, un texte trop long ou trop de champs feraient lire
        // « message envoyé » sur un message que personne n'a écrit. Aucun de ces
        // refus ne dit quelles clés existent. Le pot de miel garde le succès, lui :
        // un robot ne doit pas apprendre qu'il a été vu.
        if (!parsed.success && !trapped) {
            reply.header('Content-Type', 'text/html; charset=utf-8');
            return reply.code(400).send(invalidPage(htmlFieldOf(parsed.error)));
        }

        if (outcome.status === 'failed') {
            reply.header('Content-Type', 'text/html; charset=utf-8');
            return reply.code(503).send(RETRY_PAGE);
        }
        // Un `<form>` sans JavaScript n'a personne pour lire un JSON d'erreur : le
        // visiteur voit une page qui nomme le champ, et c'est au site de corriger
        // sa déclaration ou son formulaire.
        if (outcome.status === 'invalid') {
            reply.header('Content-Type', 'text/html; charset=utf-8');
            return reply.code(400).send(invalidPage(outcome.field));
        }

        // Le visiteur d'un `<form>` doit atterrir quelque part, refus compris :
        // lui montrer une réponse différente selon l'issue dirait à qui sonde
        // quelles clés existent.
        const next = redirectTarget(req, typeof body._next === 'string' ? body._next : null);
        if (next) return reply.code(303).header('Location', next).send();
        reply.header('Content-Type', 'text/html; charset=utf-8');
        return reply.send(THANK_YOU_PAGE);
    });
}

async function acceptEvents(
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

/**
 * Les réponses d'un envoi de formulaire HTML, réservés ôtés. Un nom répété
 * devient un tableau : c'est ainsi qu'un groupe de cases à cocher s'envoie, et
 * n'en garder qu'une perdrait les autres sans rien dire.
 */
function fromHtmlForm(body: Record<string, unknown>): Record<string, unknown> {
    const fields: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(body)) {
        if (RESERVED_FIELDS.has(name)) continue;
        fields[name] = value;
    }
    return {
        key: body._key,
        form: typeof body._form === 'string' && body._form.trim() ? body._form : 'contact',
        fields,
        path: typeof body._path === 'string' ? body._path : undefined
    };
}

/**
 * Où renvoyer le visiteur après un envoi de formulaire, ou `null`.
 *
 * La cible est confrontée à l'en-tête `Origin` de la requête, et à rien
 * d'autre : on ne renvoie que vers le site d'où l'on vient. Se fier au réglage
 * du site aurait deux défauts, faire de cette route un redirecteur ouvert pour
 * un site aux origines vides, et distinguer les refus (un `_next` honoré
 * dirait que la clé est bonne).
 *
 * Un chemin relatif est résolu sur cette même origine, ce qui est la forme
 * qu'on écrit dans une page (`/merci.html`).
 */
function redirectTarget(req: SdkPublicRequest, next: string | null): string | null {
    if (!next) return null;
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : null;
    if (!origin) return null;
    try {
        const base = new URL(origin);
        const target = new URL(next, base);
        if (target.protocol !== 'http:' && target.protocol !== 'https:') return null;
        if (normalizeHost(target.host) !== normalizeHost(base.host)) return null;
        return target.toString();
    } catch {
        return null;
    }
}
