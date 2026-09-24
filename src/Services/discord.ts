import type { Logger } from 'pino';
import { safeFetch } from './netFetch';

/**
 * Le transport Discord : le seul canal qui sache modifier ce qu'il a déjà
 * envoyé. `POST ...?wait=true` rend le message créé, donc son identifiant ;
 * `PATCH .../messages/{id}` le modifie sans limite de durée (contrairement aux
 * jetons d'interaction). Aucun bot ni jeton d'application : l'URL de webhook
 * suffit.
 */

/** Ce qu'un message porte : Discord accepte l'un, l'autre, ou les deux. */
export interface DiscordMessage {
    content?: string;
    embeds?: Record<string, unknown>[];
}

/**
 * Cette URL est-elle un webhook Discord ? Analysée, jamais cherchée dans la
 * chaîne : `includes('discord.com')` dirait oui à `?ref=discord.com`.
 * `discordapp.com` reste servi pour les URL anciennes.
 */
export function isDiscordWebhook(url: string): boolean {
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:') return false;
        const host = parsed.hostname.toLowerCase();
        const known = host === 'discord.com' || host === 'discordapp.com' || host.endsWith('.discord.com');
        return known && parsed.pathname.startsWith('/api/webhooks/');
    } catch {
        return false;
    }
}

const TIMEOUT_MS = 10_000;

/** Au-delà, un 429 se rend à l'appelant plutôt que de retenir sa file. */
const MAX_RETRY_WAIT_MS = 5_000;

/**
 * Une file par webhook : Discord en borne le débit (environ cinq requêtes par
 * deux secondes), et plusieurs émetteurs peuvent viser le même salon au même
 * instant. Sérialisés, ils se suivent au lieu de se faire refuser.
 */
const queues = new Map<string, Promise<unknown>>();

/** `/api/webhooks/{id}/{token}` : un message et son webhook partagent la file. */
function webhookKey(url: string): string {
    return new URL(url).pathname.split('/').slice(0, 5).join('/');
}

function inQueue<T>(url: string, fn: () => Promise<T>): Promise<T> {
    const key = webhookKey(url);
    const run = (queues.get(key) ?? Promise.resolve()).then(fn, fn);
    const tail = run.catch(() => undefined);
    queues.set(key, tail);
    void tail.then(() => {
        if (queues.get(key) === tail) queues.delete(key);
    });
    return run;
}

/** Le délai demandé par un 429, en millisecondes ; `null` s'il n'en dit rien de lisible. */
function retryAfterMs(response: Response): number | null {
    const seconds = Number.parseFloat(response.headers.get('retry-after') ?? '');
    return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1000) : null;
}

/** Un envoi, repris une fois après le délai qu'un 429 demande s'il est court. */
async function send(url: string, init: { method: string; body: string }): Promise<Response> {
    const once = () =>
        safeFetch(url, {
            ...init,
            headers: { 'content-type': 'application/json' },
            signal: AbortSignal.timeout(TIMEOUT_MS)
        });
    const response = await once();
    if (response.status !== 429) return response;
    const wait = retryAfterMs(response);
    if (wait === null || wait > MAX_RETRY_WAIT_MS) return response;
    await new Promise((resolve) => setTimeout(resolve, wait));
    return once();
}

/**
 * Publie un message et rend son identifiant, ou `null` si Discord l'a refusé :
 * l'appelant retombe alors sur le message unique de fin.
 */
export async function postMessage(url: string, message: DiscordMessage, logger: Logger): Promise<string | null> {
    if (!isDiscordWebhook(url)) {
        logger.warn('Discord: adresse refusée, ce n’est pas un webhook Discord');
        return null;
    }
    try {
        const response = await inQueue(url, () =>
            send(withWait(url), { method: 'POST', body: JSON.stringify(message) })
        );
        if (!response.ok) {
            logger.warn({ status: response.status, detail: await detailOf(response) }, 'Discord: message refusé');
            return null;
        }
        const body = (await response.json()) as { id?: unknown };
        return typeof body.id === 'string' ? body.id : null;
    } catch (e) {
        logger.warn({ err: e instanceof Error ? e.message : String(e) }, 'Discord: publication impossible');
        return null;
    }
}

/**
 * Modifie un message déjà publié. `false` quand Discord refuse (message
 * supprimé à la main, webhook révoqué) : l'appelant s'arrête là plutôt que de
 * republier.
 */
export async function editMessage(
    url: string,
    messageId: string,
    message: DiscordMessage,
    logger: Logger
): Promise<boolean> {
    if (!isDiscordWebhook(url)) {
        logger.warn('Discord: adresse refusée, ce n’est pas un webhook Discord');
        return false;
    }
    try {
        const response = await inQueue(url, () =>
            send(messageUrl(url, messageId), { method: 'PATCH', body: JSON.stringify(message) })
        );
        if (response.ok) return true;
        logger.warn({ status: response.status, detail: await detailOf(response) }, 'Discord: modification refusée');
        return false;
    } catch (e) {
        logger.warn({ err: e instanceof Error ? e.message : String(e) }, 'Discord: modification impossible');
        return false;
    }
}

/**
 * `?wait=true`, en préservant les paramètres déjà présents (`thread_id` en
 * particulier : l'écraser posterait dans le salon parent).
 */
function withWait(url: string): string {
    const parsed = new URL(url);
    parsed.searchParams.set('wait', 'true');
    return parsed.toString();
}

/**
 * L'adresse d'un message existant. `wait` retiré (il n'a de sens qu'à la
 * création), `thread_id` conservé.
 */
function messageUrl(url: string, messageId: string): string {
    const parsed = new URL(url);
    parsed.searchParams.delete('wait');
    parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/messages/${encodeURIComponent(messageId)}`;
    return parsed.toString();
}

/** Les mots de Discord valent mieux que « HTTP 400 » : il nomme le champ fautif. */
async function detailOf(response: Response): Promise<string> {
    return response
        .text()
        .then((body) => body.slice(0, 200).trim())
        .catch(() => '');
}
