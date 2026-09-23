import { createHash } from 'crypto';

import { AUDIENCE_LABEL_MAX_LENGTH, AUDIENCE_ORIGIN_ANY, type AudiencePlatform } from '../contracts/domain';

/**
 * Ce qui transforme une saisie du monde extérieur en valeur rangeable.
 *
 * Tout ici est pur : aucune base, aucun réseau, aucune horloge. Ces règles
 * décident si deux visites comptent pour la même page, et une erreur s'y
 * traduirait par des statistiques fausses plutôt que par une panne.
 */

/**
 * L'identité d'un libellé, ce que `content` chiffré ne peut pas porter : 16
 * caractères du sha256, collision hors de portée pratique et index court.
 */
export function labelRef(value: string): string {
    return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

/**
 * Le chemin d'une page, ou le nom d'un écran.
 *
 * La requête et l'ancre sont retirées : les garder ferait de chaque
 * `?utm_source=…` une ligne de plus dans le classement, et la provenance est
 * déjà portée par le référent. La barre finale part aussi, sauf sur la racine :
 * `/tarifs` et `/tarifs/` sont la même page, sauf pour un `GROUP BY`.
 */
export function normalizePath(raw: string): string {
    let value = raw.trim();
    if (!value) return '/';

    // Une URL complète est acceptée : un client natif peut n'avoir que ça, et exiger
    // qu'il la découpe dupliquerait cette règle chez chaque appelant.
    if (/^https?:\/\//i.test(value)) {
        try {
            value = new URL(value).pathname;
        } catch {
            // URL illisible : on garde la chaîne telle quelle, le nettoyage ci-dessous
            // suffit. Refuser perdrait la visite pour une raison qui n'intéresse personne.
        }
    }

    const cut = value.search(/[?#]/);
    if (cut >= 0) value = value.slice(0, cut);

    if (!value.startsWith('/')) value = `/${value}`;
    if (value.length > 1 && value.endsWith('/')) value = value.slice(0, -1);

    return value.slice(0, AUDIENCE_LABEL_MAX_LENGTH) || '/';
}

/**
 * L'hôte d'une origine, quelle que soit la forme reçue : `https://exemple.fr`,
 * `exemple.fr:443` et `EXEMPLE.FR/` rendent tous `exemple.fr`. Une seule forme
 * canonique des deux côtés de la comparaison (le réglage saisi et l'en-tête
 * `Origin`), sinon l'autorisation dépendrait de la façon de taper le domaine.
 */
export function normalizeHost(raw: string): string {
    let value = raw.trim().toLowerCase();
    if (!value) return '';
    value = value.replace(/^[a-z]+:\/\//, '');
    // Chemin, requête, ancre : rien de tout cela n'appartient à un hôte.
    value = value.split('/')[0].split('?')[0].split('#')[0];
    // Le port ne fait pas partie de l'identité d'une origine : le même site en 3000
    // sur un poste de dev et en 443 en production reste le même. IPv6 littérale
    // exceptée, dont les deux-points sont l'écriture même.
    if (!value.startsWith('[')) value = value.split(':')[0];
    return value;
}

/**
 * D'où vient le visiteur : l'hôte seul, jamais l'URL complète, qui serait un
 * bon moyen d'accumuler des adresses personnelles sans l'avoir voulu.
 *
 * Une navigation interne ne produit aucun référent, sans quoi le premier du
 * classement serait toujours le site lui-même.
 */
export function normalizeReferrer(raw: string | undefined, ownHosts: readonly string[]): string | null {
    if (!raw) return null;
    const host = normalizeHost(raw);
    if (!host) return null;
    if (ownHosts.includes(host)) return null;
    return host.slice(0, AUDIENCE_LABEL_MAX_LENGTH);
}

/**
 * L'origine a-t-elle le droit d'écrire sur ce site ? Quatre règles, dans
 * l'ordre :
 *
 * 1. **aucune origine déclarée : rien n'entre.** La première version acceptait
 *    tout dans ce cas, ce qui faisait du réglage par défaut le plus permissif
 *    de tous : un site à peine créé était une boîte aux lettres ouverte à qui
 *    lisait sa clé. Refuser oblige à dire ce qu'on attend, et l'écran le dit.
 * 2. `*` : on accepte tout, mais parce qu'on l'a écrit. Même effet qu'avant,
 *    désormais relisible dans les réglages.
 * 3. plateforme `app` : rien à confronter, un binaire natif n'envoie pas
 *    d'`Origin`, et refuser son absence lui fermerait la porte.
 * 4. `web` ou `both` : l'`Origin` présent doit figurer dans la liste. Son
 *    absence est refusée en `web` (une page en envoie toujours un) et tolérée
 *    en `both`, qui dit qu'on attend les deux mondes.
 *
 * Cette garde n'arrête qu'un navigateur : l'en-tête `Origin` est posé par lui,
 * et un script en met ce qu'il veut. Elle empêche un autre site d'abuser de la
 * clé depuis le navigateur d'un visiteur, ce qui est déjà l'essentiel, mais
 * ce sont les quotas qui bornent un envoi forgé.
 */
export function originAllowed(
    origins: readonly string[],
    originHeader: string | null,
    platform: AudiencePlatform
): boolean {
    if (origins.length === 0) return false;
    if (origins.includes(AUDIENCE_ORIGIN_ANY)) return true;
    if (platform === 'app') return true;

    const host = originHeader ? normalizeHost(originHeader) : '';
    if (!host) return platform === 'both';
    return origins.includes(host);
}

/**
 * Le condensé d'un visiteur : `sel + clé du site + IP + user-agent`, tronqué.
 * Ni l'IP ni le user-agent ne sont conservés, ils entrent ici et n'en ressortent
 * pas. Le sel tournant chaque jour, le même visiteur n'est pas reconnaissable
 * d'un jour à l'autre : c'est le prix d'une mesure sans consentement.
 *
 * La clé du site entre dans le condensé pour qu'un même visiteur ne porte pas
 * le même identifiant sur deux sites, donc qu'on ne puisse pas les croiser.
 */
export function visitorRef(salt: string, siteKey: string, ip: string, userAgent: string): string {
    return createHash('sha256')
        .update(salt)
        .update(' ')
        .update(siteKey)
        .update(' ')
        .update(ip)
        .update(' ')
        .update(userAgent)
        .digest('hex')
        .slice(0, 16);
}

/**
 * Le condensé d'un visiteur reconnu d'une visite à l'autre, en mode persistant :
 * le client range un identifiant tiré au sort et le renvoie à chaque mesure.
 * Aucun sel du jour ici, sinon la personne changerait d'identité chaque nuit.
 *
 * L'identifiant reçu n'est jamais stocké tel quel, et la clé du site entre dans
 * le condensé : posé sur deux sites, il y produit deux empreintes sans rapport.
 */
export function persistentVisitorRef(secret: string, siteKey: string, visitorId: string): string {
    return createHash('sha256')
        .update(secret)
        .update(' v ')
        .update(siteKey)
        .update(' ')
        .update(visitorId)
        .digest('hex')
        .slice(0, 16);
}

/** Le jour UTC d'un instant, en `YYYYMMDD` : la clé d'`audience_daily`. */
export function dayKey(tsSeconds: number): number {
    const d = new Date(tsSeconds * 1000);
    return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

/** Le mois UTC d'un instant, en `YYYYMM` : la clé de `ft_audience_usage`. */
export function monthKey(tsSeconds: number): number {
    const d = new Date(tsSeconds * 1000);
    return d.getUTCFullYear() * 100 + d.getUTCMonth() + 1;
}

/** Les bornes UTC du jour qui contient cet instant, en secondes. */
export function dayBounds(tsSeconds: number): { from: number; to: number } {
    const from = Math.floor(tsSeconds / 86400) * 86400;
    return { from, to: from + 86400 };
}
