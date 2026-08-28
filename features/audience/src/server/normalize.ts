import { createHash } from 'crypto';

import { AUDIENCE_LABEL_MAX_LENGTH, type AudiencePlatform } from '../contracts/domain';

/**
 * Ce qui transforme une saisie du monde extérieur en valeur rangeable.
 *
 * Tout ici est **pur** : aucune base, aucun réseau, aucune horloge. C'est ce qui
 * rend ces règles vérifiables seules avec `tsx`, et c'est nécessaire — ce sont
 * elles qui décident si deux visites comptent pour la même page, et une erreur
 * s'y traduirait par des statistiques fausses plutôt que par une panne.
 */

/**
 * L'identité d'un libellé, ce que `content` chiffré ne peut pas porter.
 *
 * Même motif que `slug_ref` (git) et `name_ref` (bases) : 16 caractères du
 * sha256. La collision y est hors de portée pratique, et la colonne reste
 * courte, donc l'index tient en mémoire.
 */
export function labelRef(value: string): string {
    return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

/**
 * Le chemin d'une page, ou le nom d'un écran.
 *
 * **La requête et l'ancre sont retirés**, et c'est la décision qui compte ici :
 * les garder ferait de chaque `?utm_source=…` une ligne de plus dans le
 * classement, et « /produits » finirait éparpillé sur trois cents entrées qui
 * ne disent rien. Ce qu'on perd — la provenance — est déjà porté par le
 * référent, à sa place et sans multiplier les pages.
 *
 * La barre finale est retirée aussi, sauf sur la racine : `/tarifs` et
 * `/tarifs/` sont la même page pour tout le monde sauf pour un `GROUP BY`.
 */
export function normalizePath(raw: string): string {
    let value = raw.trim();
    if (!value) return '/';

    // Une URL complète est acceptée : un client natif peut n'avoir que ça, et
    // exiger de lui qu'il la découpe reviendrait à dupliquer cette règle chez
    // chaque appelant.
    if (/^https?:\/\//i.test(value)) {
        try {
            value = new URL(value).pathname;
        } catch {
            // URL illisible : on garde la chaîne telle quelle, le nettoyage
            // ci-dessous suffit. Refuser perdrait la visite pour une raison qui
            // n'intéresse personne.
        }
    }

    const cut = value.search(/[?#]/);
    if (cut >= 0) value = value.slice(0, cut);

    if (!value.startsWith('/')) value = `/${value}`;
    if (value.length > 1 && value.endsWith('/')) value = value.slice(0, -1);

    return value.slice(0, AUDIENCE_LABEL_MAX_LENGTH) || '/';
}

/**
 * L'hôte d'une origine, quelle que soit la forme reçue.
 *
 * Accepte `https://exemple.fr`, `exemple.fr:443`, `EXEMPLE.FR/` — et rend
 * toujours `exemple.fr`. Une seule forme canonique des deux côtés de la
 * comparaison : celle que l'utilisateur a saisie dans les réglages, et celle
 * que le navigateur envoie dans l'en-tête `Origin`. Les comparer sans cela
 * aurait fait dépendre l'autorisation de la façon dont on a tapé le domaine.
 */
export function normalizeHost(raw: string): string {
    let value = raw.trim().toLowerCase();
    if (!value) return '';
    value = value.replace(/^[a-z]+:\/\//, '');
    // Chemin, requête, ancre : rien de tout cela n'appartient à un hôte.
    value = value.split('/')[0].split('?')[0].split('#')[0];
    // Le port ne fait pas partie de l'identité d'une origine ici : le même site
    // en 3000 sur un poste de dev et en 443 en production reste le même site.
    // IPv6 littérale exceptée, dont les deux-points sont l'écriture même.
    if (!value.startsWith('[')) value = value.split(':')[0];
    return value;
}

/**
 * D'où vient le visiteur — l'**hôte seul**, jamais l'URL complète.
 *
 * Deux raisons de ne garder que l'hôte : une URL de référent complète est un
 * bon moyen d'accumuler des adresses personnelles sans l'avoir voulu, et la
 * question qu'on se pose est « qui m'envoie du monde », pas « depuis quelle
 * page exactement ».
 *
 * Une navigation interne ne produit **aucun** référent : sans cette règle, le
 * premier du classement serait toujours le site lui-même, ce qui n'apprend
 * rien et masque les vrais.
 */
export function normalizeReferrer(raw: string | undefined, ownHosts: readonly string[]): string | null {
    if (!raw) return null;
    const host = normalizeHost(raw);
    if (!host) return null;
    if (ownHosts.includes(host)) return null;
    return host.slice(0, AUDIENCE_LABEL_MAX_LENGTH);
}

/**
 * L'origine a-t-elle le droit d'écrire sur ce site ?
 *
 * Trois règles, et l'ordre compte :
 *
 * 1. **aucune origine déclarée** → on accepte tout. C'est l'état d'un site
 *    qu'on vient de créer, le temps de brancher la balise ; l'écran le signale
 *    plutôt que de laisser croire à une protection qui n'existe pas.
 * 2. **plateforme `app`** → il n'y a rien à confronter, un binaire natif
 *    n'envoie pas d'`Origin`. Refuser son absence lui fermerait la porte pour
 *    de bon.
 * 3. **`web` ou `both`** → l'`Origin` présent doit figurer dans la liste. Son
 *    *absence* est refusée en `web` (une page en envoie toujours un, donc son
 *    absence dénonce un client qui n'en est pas une) et tolérée en `both`, qui
 *    dit précisément qu'on attend les deux mondes.
 */
export function originAllowed(
    origins: readonly string[],
    originHeader: string | null,
    platform: AudiencePlatform
): boolean {
    if (origins.length === 0) return true;
    if (platform === 'app') return true;

    const host = originHeader ? normalizeHost(originHeader) : '';
    if (!host) return platform === 'both';
    return origins.includes(host);
}

/**
 * Le condensé d'un visiteur.
 *
 * `sel + clé du site + IP + user-agent`, tronqué. **Ni l'IP ni le user-agent
 * ne sont conservés** : ils entrent ici et n'en ressortent pas. Le sel tournant
 * quotidiennement, le même visiteur n'est pas reconnaissable d'un jour à
 * l'autre — ce qui est une limite assumée (pas de « visiteurs récurrents ») et
 * le prix d'une mesure qui ne demande aucun consentement.
 *
 * La clé du site entre dans le condensé pour qu'un même visiteur ne porte pas
 * le même identifiant sur deux sites : croiser les audiences de deux clients
 * n'est pas quelque chose que ce système doit rendre possible.
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
 * Le condensé d'un visiteur **reconnu d'une visite à l'autre**.
 *
 * Employé seulement quand le site est en mode persistant : le client range un
 * identifiant tiré au sort dans son navigateur et le renvoie à chaque mesure.
 * Aucun sel du jour ici, sinon la personne changerait d'identité chaque nuit et
 * le mode n'apporterait rien.
 *
 * L'identifiant reçu n'est **jamais stocké tel quel**, et la clé du site entre
 * dans le condensé : un même identifiant posé sur deux sites y produit deux
 * empreintes sans rapport, donc aucun recoupement n'est possible même en
 * regardant la base.
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

/** Le jour UTC d'un instant, en `YYYYMMDD` — la clé d'`audience_daily`. */
export function dayKey(tsSeconds: number): number {
    const d = new Date(tsSeconds * 1000);
    return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

/** Les bornes UTC du jour qui contient cet instant, en secondes. */
export function dayBounds(tsSeconds: number): { from: number; to: number } {
    const from = Math.floor(tsSeconds / 86400) * 86400;
    return { from, to: from + 86400 };
}
