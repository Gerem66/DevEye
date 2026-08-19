import type { Logger } from 'pino';

/**
 * Le transport Discord — **le seul canal qui sache modifier ce qu'il a déjà
 * envoyé**.
 *
 * Tout le reste de `Services/notifications.ts` est délibérément agnostique : une
 * seule URL, une charge utile à trois têtes (`content` pour Discord, `text` pour
 * Slack, les champs structurés pour un point d'entrée maison), et jamais la
 * question « quel service ? » posée à la configuration. Ce module est
 * l'exception assumée, parce que la capacité qu'il exploite n'existe que là :
 *
 *  - `POST /api/webhooks/{id}/{token}` **`?wait=true`** rend le message créé,
 *    donc son identifiant — sans ce paramètre, Discord répond `204` vide et la
 *    réponse ne sert à rien (c'est ce que fait la livraison ordinaire).
 *  - `PATCH /api/webhooks/{id}/{token}/messages/{id}` le modifie, **sans limite
 *    de durée**. C'est une différence de fond avec les jetons d'interaction,
 *    qui expirent au bout d'un quart d'heure : un déploiement d'une heure peut
 *    donc être suivi dans un seul message du début à la fin.
 *
 * Aucun bot, aucun jeton d'application : l'URL de webhook que l'utilisateur a
 * déjà collée suffit. C'est ce qui permet d'ajouter le suivi vivant **sans rien
 * demander de plus** à qui a réglé un webhook Discord, et sans rien retirer à
 * qui en a réglé un autre — les autres canaux gardent leur message unique.
 */

/** Ce qu'un message porte : Discord accepte l'un, l'autre, ou les deux. */
export interface DiscordMessage {
    content?: string;
    embeds?: Record<string, unknown>[];
}

/**
 * Cette URL est-elle un webhook Discord ?
 *
 * Analysée, jamais cherchée dans la chaîne : `includes('discord.com')` dirait
 * oui à `https://exemple.com/?ref=discord.com`, et l'on enverrait alors des
 * requêtes de modification à un point d'entrée qui n'en attend pas. Les deux
 * domaines sont acceptés — `discordapp.com` reste servi pour les URL anciennes,
 * que personne n'a de raison d'être allé recopier.
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

/**
 * Publie un message et rend son identifiant, ou `null` si Discord l'a refusé.
 *
 * `null` n'est pas une erreur à faire remonter : l'appelant retombe alors sur le
 * message unique de fin, qui reste juste. Un suivi vivant qui n'a pas pu
 * commencer ne doit jamais empêcher l'avis d'arriver.
 */
export async function postMessage(url: string, message: DiscordMessage, logger: Logger): Promise<string | null> {
    try {
        const response = await fetch(withWait(url), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            signal: AbortSignal.timeout(TIMEOUT_MS),
            body: JSON.stringify(message)
        });
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
 * Modifie un message déjà publié.
 *
 * `false` quand Discord refuse — le plus souvent parce que le message a été
 * supprimé à la main, ou le webhook révoqué. L'appelant s'arrête là plutôt que
 * de republier : quelqu'un qui efface le message de suivi ne demande pas qu'on
 * lui en pose un autre à sa place.
 */
export async function editMessage(
    url: string,
    messageId: string,
    message: DiscordMessage,
    logger: Logger
): Promise<boolean> {
    try {
        const response = await fetch(`${messageUrl(url, messageId)}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            signal: AbortSignal.timeout(TIMEOUT_MS),
            body: JSON.stringify(message)
        });
        if (response.ok) return true;
        logger.warn({ status: response.status, detail: await detailOf(response) }, 'Discord: modification refusée');
        return false;
    } catch (e) {
        logger.warn({ err: e instanceof Error ? e.message : String(e) }, 'Discord: modification impossible');
        return false;
    }
}

/**
 * `?wait=true`, en préservant les paramètres déjà présents.
 *
 * `thread_id` en particulier : une URL copiée depuis un fil de discussion le
 * porte, et l'écraser posterait le message dans le salon parent — au mauvais
 * endroit, sans que rien ne le signale.
 */
function withWait(url: string): string {
    const parsed = new URL(url);
    parsed.searchParams.set('wait', 'true');
    return parsed.toString();
}

/**
 * L'adresse d'un message existant.
 *
 * Les paramètres de requête sont **conservés** et `wait` retiré : il n'a de sens
 * qu'à la création, alors que `thread_id` reste nécessaire pour retrouver un
 * message publié dans un fil.
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
