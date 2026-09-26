import { z } from 'zod';

/**
 * Deux idées : `detectTarget()` est une fonction pure définie ici et nulle part
 * ailleurs (le client l'appelle à la frappe, le serveur la ré-applique), et
 * toutes les sondes rendent la même forme, {@link osintProbeResultSchema}.
 * Rien ici n'est un secret ; ce qui est sensible, c'est la question posée, d'où
 * l'historique chiffré.
 */

/* ------------------------------- La cible -------------------------------- */

export const osintTargetKindSchema = z.enum([
    'domain',
    'ip',
    'url',
    'email',
    'phone',
    /** Deux mots ou plus : traité comme une identité civile. */
    'person',
    /** Le repli : un identifiant d'un seul tenant (`@pseudo`, `pseudo`). */
    'username'
]);
export type OsintTargetKind = z.infer<typeof osintTargetKindSchema>;

export const OSINT_KIND_LABELS: Record<OsintTargetKind, string> = {
    domain: 'Domaine',
    url: 'URL',
    ip: 'Adresse IP',
    email: 'Adresse e-mail',
    phone: 'Téléphone',
    person: 'Personne',
    username: 'Pseudo'
};

export const OSINT_QUERY_MAX_LENGTH = 253;

export const osintTargetSchema = z.object({
    kind: osintTargetKindSchema,
    /** La saisie telle quelle, débarrassée des espaces de bord. */
    query: z.string().min(1).max(OSINT_QUERY_MAX_LENGTH),
    /**
     * La forme canonique sur laquelle les sondes travaillent : domaine en
     * minuscules et sans `www.`, IP normalisée, numéro en E.164, adresse en
     * minuscules, pseudo sans `@`. C'est **toujours** ce champ que lit une
     * sonde, jamais `query`.
     */
    value: z.string().min(1).max(OSINT_QUERY_MAX_LENGTH)
});
export type OsintTarget = z.infer<typeof osintTargetSchema>;

/* ------------------------------- Les sondes ------------------------------ */

export const osintProbeIdSchema = z.enum([
    // Domaine / infrastructure
    'dns',
    'rdap',
    'whois',
    'tls',
    'http',
    'crtsh',
    // Adresse IP
    'ptr',
    'rdapIp',
    'geoip',
    'blocklist',
    'ports',
    // Domaine ou IP
    'virustotal',
    // Téléphone
    'phone',
    // Adresse e-mail
    'email',
    'pgp',
    'breaches',
    // Identité
    'username',
    'registry',
    'deaths',
    'wikidata',
    'github',
    'gravatar',
    'keybase',
    // Toutes cibles
    'dorks'
]);
export type OsintProbeId = z.infer<typeof osintProbeIdSchema>;

export type OsintKeyMode = 'optional' | 'required';

export interface OsintProbeMeta {
    /** Libellé humain. Sert aussi au squelette de carte, avant tout résultat. */
    label: string;
    /** Ce que la sonde interroge, nommé pour qui choisit ses clés. */
    source: string;
    /**
     * Le fournisseur dont une clé enrichit la sonde (`optional`) ou la rend
     * possible (`required`). Sans clé exigée posée, la sonde est indisponible.
     */
    key?: { provider: OsintProvider; mode: OsintKeyMode };
}

/** Le catalogue des sondes : le serveur y lit la clé à fournir, les réglages tout le reste. */
export const OSINT_PROBE_META: Record<OsintProbeId, OsintProbeMeta> = {
    dns: { label: 'DNS', source: 'Résolveurs publics de Cloudflare (1.1.1.1) et de Google (8.8.8.8)' },
    rdap: { label: 'RDAP', source: 'rdap.org, qui renvoie vers le registre du domaine' },
    whois: { label: 'WHOIS', source: 'Serveur WHOIS du registre, trouvé par whois.iana.org' },
    tls: { label: 'Certificat TLS', source: 'Connexion TLS directe au serveur' },
    http: { label: 'En-têtes HTTP', source: 'Requête directe au site' },
    crtsh: { label: 'Sous-domaines', source: 'crt.sh, les journaux publics de certificats' },
    ptr: { label: 'Reverse DNS', source: 'Résolveurs publics de Cloudflare et de Google' },
    rdapIp: { label: 'Bloc réseau', source: 'rdap.org, qui renvoie vers le registre régional (RIPE, ARIN…)' },
    geoip: { label: 'Géolocalisation', source: 'ipwho.is' },
    blocklist: {
        label: 'Réputation',
        source: 'Listes noires SpamCop et Barracuda, et Spamhaus avec une clé DQS',
        key: { provider: 'spamhaus', mode: 'optional' }
    },
    ports: {
        label: 'Ports ouverts',
        source: 'Shodan InternetDB, ou l’API Shodan avec une clé',
        key: { provider: 'shodan', mode: 'optional' }
    },
    virustotal: {
        label: 'VirusTotal',
        source: 'VirusTotal, verdicts des moteurs antivirus',
        key: { provider: 'virustotal', mode: 'required' }
    },
    phone: {
        label: 'Numéro',
        source: 'Plages d’attribution embarquées (libphonenumber), et Numverify avec une clé',
        key: { provider: 'numverify', mode: 'optional' }
    },
    email: { label: 'Adresse e-mail', source: 'DNS du domaine, liste de domaines jetables, Gravatar' },
    pgp: { label: 'Clés PGP', source: 'keyserver.ubuntu.com et keys.openpgp.org' },
    breaches: {
        label: 'Fuites de données',
        source: 'Have I Been Pwned',
        key: { provider: 'hibp', mode: 'required' }
    },
    username: { label: 'Profils', source: 'GitHub, Reddit, Instagram, TikTok, Twitch et une vingtaine d’autres sites' },
    registry: {
        label: 'Registre du commerce',
        source: 'Annuaire des entreprises (data.gouv.fr), ou Pappers avec une clé',
        key: { provider: 'pappers', mode: 'optional' }
    },
    deaths: { label: 'Décès (INSEE)', source: 'Fichier des personnes décédées de l’INSEE, par matchID' },
    wikidata: { label: 'Wikidata', source: 'Wikidata, la base de Wikipédia' },
    github: { label: 'GitHub', source: 'API GitHub', key: { provider: 'github', mode: 'optional' } },
    gravatar: { label: 'Gravatar', source: 'API Gravatar' },
    keybase: { label: 'Keybase', source: 'API Keybase' },
    dorks: {
        label: 'Pivots',
        source: 'Recherches Google, Bing, DuckDuckGo et annuaires, ouvertes dans votre navigateur'
    }
};

/** Sondes lentes par nature : le client les place en fin de grille. */
export const OSINT_SLOW_PROBES: readonly OsintProbeId[] = ['crtsh', 'username', 'whois', 'github', 'wikidata'];

/* ------------------------------ Le résultat ------------------------------ */

export const osintToneSchema = z.enum(['neutral', 'good', 'warn', 'bad']);
export type OsintTone = z.infer<typeof osintToneSchema>;

/** Une ligne du corps de carte. `href` la rend cliquable, `mono` la met en chasse fixe. */
export const osintFieldSchema = z.object({
    label: z.string(),
    value: z.string(),
    mono: z.boolean().optional(),
    href: z.string().optional()
});
export type OsintField = z.infer<typeof osintFieldSchema>;

export const osintTagSchema = z.object({
    label: z.string(),
    tone: osintToneSchema
});
export type OsintTag = z.infer<typeof osintTagSchema>;

export const osintLinkSchema = z.object({
    label: z.string(),
    href: z.string()
});
export type OsintLink = z.infer<typeof osintLinkSchema>;

/**
 * Un jugement chiffré et son barème : la carte affiche les signaux qui ont
 * produit la note. Un score sans son barème ne s'audite pas.
 */
export const osintScoreSchema = z.object({
    value: z.number().int().min(0).max(100),
    label: z.string(),
    tone: osintToneSchema,
    signals: z.array(z.object({ label: z.string(), delta: z.number().int() }))
});
export type OsintScore = z.infer<typeof osintScoreSchema>;

export const osintProbeStatusSchema = z.enum([
    'ok',
    /** La sonde a répondu, mais il n'y avait rien à dire (aucun MX, aucun profil…). */
    'empty',
    'error',
    /** Sonde applicable, mais sa clé API n'est pas posée. Jamais une erreur. */
    'skipped'
]);
export type OsintProbeStatus = z.infer<typeof osintProbeStatusSchema>;

export const osintProbeResultSchema = z.object({
    probe: osintProbeIdSchema,
    status: osintProbeStatusSchema,
    title: z.string(),
    summary: z.string().nullable(),
    fields: z.array(osintFieldSchema),
    tags: z.array(osintTagSchema),
    links: z.array(osintLinkSchema),
    score: osintScoreSchema.nullable(),
    /** Réponse brute dépliable (texte WHOIS, JSON du fournisseur). Tronquée côté serveur. */
    raw: z.string().nullable(),
    tookMs: z.number().int().nonnegative()
});
export type OsintProbeResult = z.infer<typeof osintProbeResultSchema>;

export const OSINT_RAW_MAX_LENGTH = 20_000;

/* ------------------------------ L'historique ----------------------------- */

export const osintHistoryEntrySchema = z.object({
    id: z.uuid(),
    kind: osintTargetKindSchema,
    /** Déchiffré à la lecture. Null quand le coffre n'a pas pu être ouvert. */
    query: z.string().nullable(),
    createdAt: z.number().int()
});
export type OsintHistoryEntry = z.infer<typeof osintHistoryEntrySchema>;

export const OSINT_HISTORY_PAGE_MAX = 100;

/* --------------------------------- L'offre -------------------------------- */

/**
 * La clé du quota que le manifest déclare (`osint.lookupsPerMonth` pour l'offre) :
 * les recherches lancées dans le mois, en UTC, sur tous les espaces du
 * propriétaire. Relancer une sonde d'une recherche ne compte pas.
 */
export const OSINT_LOOKUP_QUOTA = 'lookupsPerMonth';

export const osintUsageSchema = z.object({
    used: z.number().int().nonnegative(),
    limit: z.number().int().nonnegative()
});
export type OsintUsage = z.infer<typeof osintUsageSchema>;

/**
 * Ligne SQL. `query_enc` est chiffré à l'étage gardé : la question posée est la
 * donnée la plus sensible de la feature. `kind` reste en clair pour grouper la
 * liste sans déchiffrer.
 */
export interface OsintLookupRow {
    id: string;
    workspace_id: number;
    user_id: number;
    kind: OsintTargetKind;
    query_enc: string;
    created: number;
}

/* ---------------------------- Clés optionnelles --------------------------- */

/**
 * Fournisseurs qu'une clé débloque. Aucun n'est requis : une sonde dont la clé
 * manque rend `skipped` avec le lien pour en obtenir une, jamais une erreur.
 */
export const osintProviderSchema = z.enum([
    'pappers',
    'numverify',
    'hibp',
    'shodan',
    'virustotal',
    'github',
    'spamhaus'
]);
export type OsintProvider = z.infer<typeof osintProviderSchema>;

/**
 * Le tarif d'un service : `freemium` a une offre gratuite (souvent plafonnée)
 * et des offres payantes au-dessus.
 */
export type OsintPricing = 'free' | 'freemium' | 'paid';

export const OSINT_PRICING_LABELS: Record<OsintPricing, string> = {
    free: 'gratuit',
    freemium: 'gratuit et payant',
    paid: 'payant'
};

export const OSINT_PROVIDER_META: Record<
    OsintProvider,
    { label: string; signupUrl: string; enables: string; pricing: OsintPricing }
> = {
    pappers: {
        label: 'Pappers',
        signupUrl: 'https://www.pappers.fr/api',
        enables: 'Recherche des mandats de dirigeant par Pappers, à la place de l’annuaire public des entreprises.',
        pricing: 'freemium'
    },
    numverify: {
        label: 'Numverify',
        signupUrl: 'https://numverify.com/',
        enables: "Opérateur réel d'un numéro, au-delà de la plage d'attribution.",
        pricing: 'freemium'
    },
    hibp: {
        label: 'Have I Been Pwned',
        signupUrl: 'https://haveibeenpwned.com/API/Key',
        enables: 'Fuites de données connues pour une adresse e-mail.',
        pricing: 'paid'
    },
    shodan: {
        label: 'Shodan',
        signupUrl: 'https://account.shodan.io/register',
        enables: "Logiciel et version de chaque service ouvert d'une IP, au-delà de la liste de ports gratuite.",
        pricing: 'freemium'
    },
    virustotal: {
        label: 'VirusTotal',
        signupUrl: 'https://www.virustotal.com/gui/join-us',
        enables: 'Réputation multi-moteurs des domaines et des IP.',
        pricing: 'freemium'
    },
    github: {
        label: 'GitHub',
        signupUrl: 'https://github.com/settings/personal-access-tokens/new',
        enables:
            'Un jeton personnel, gratuit et sans aucun droit, lève la limite de la carte GitHub : sans lui, quelques recherches par heure pour tout le serveur.',
        pricing: 'free'
    },
    spamhaus: {
        label: 'Spamhaus DQS',
        signupUrl: 'https://www.spamhaus.com/free-trial/sign-up-for-a-free-data-query-service-account/',
        enables:
            'Ajoute la liste Spamhaus ZEN à la réputation d’une IP. Le compte gratuit est réservé à un usage non commercial, au-delà il est payant.',
        pricing: 'freemium'
    }
};

export interface OsintProviderKeyRow {
    workspace_id: number;
    provider: OsintProvider;
    key_enc: string;
}

export const osintProviderStatusSchema = z.object({
    provider: osintProviderSchema,
    hasKey: z.boolean()
});
export type OsintProviderStatus = z.infer<typeof osintProviderStatusSchema>;

/* ------------------------------- Détection ------------------------------- */

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
/** Volontairement permissif : `net.isIPv6` tranchera côté serveur. */
const IPV6 = /^[0-9a-f:]+$/i;
const EMAIL = /^[^\s@]+@([a-z0-9-]+\.)+[a-z]{2,}$/i;
const DOMAIN = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const USERNAME = /^@?[a-z0-9][a-z0-9._-]{1,38}$/i;

function isIpv4(s: string): boolean {
    const m = s.match(IPV4);
    return m !== null && m.slice(1).every((o) => Number(o) <= 255 && (o === '0' || !o.startsWith('0')));
}

/**
 * IPv6 littérale. Écarte les deux faux positifs qui comptent : `host:port` (un
 * seul deux-points, et un côté non hexadécimal) et `12:34` (une heure).
 */
function isIpv6(s: string): boolean {
    if (!s.includes(':') || !IPV6.test(s)) return false;
    if (/^\d+:\d+$/.test(s)) return false;
    return s.split(':').filter(Boolean).length >= 2;
}

/**
 * Un numéro se reconnaît à ses chiffres, pas à sa ponctuation : on retire tout
 * ce qui sépare (espaces, points, tirets, parenthèses) avant de compter.
 * `+` n'est accepté qu'en tête, une seule fois.
 */
function phoneDigits(s: string): string | null {
    const compact = s.replace(/[\s.\-()/]/g, '');
    if (!/^\+?\d+$/.test(compact)) return null;
    const digits = compact.replace(/^\+/, '');
    if (digits.length < 6 || digits.length > 15) return null;
    return compact.startsWith('+') ? `+${digits}` : digits;
}

/**
 * De quelle nature est cette saisie ?
 *
 * L'ordre des tests **est** la règle de désambiguïsation, et il est choisi pour
 * que le cas le plus spécifique gagne toujours :
 *  - une IP avant un domaine (`1.2.3.4` a bien la forme d'un domaine) ;
 *  - une URL avant un domaine, pour en extraire l'hôte ;
 *  - une adresse e-mail avant un pseudo (l'arobase tranche) ;
 *  - un numéro avant un pseudo (`0612345678` passerait pour un identifiant) ;
 *  - un domaine avant un pseudo (le point tranche) ;
 *  - une personne dès qu'il y a une espace ;
 *  - un pseudo en dernier, comme repli.
 *
 * Ne lève jamais : une saisie que rien ne reconnaît devient `person` si elle
 * contient une espace, `username` sinon. Le pire cas est une sonde inutile, pas
 * une erreur à l'écran.
 */
export function detectTarget(raw: string): OsintTarget {
    const query = raw.trim().slice(0, OSINT_QUERY_MAX_LENGTH);
    const mk = (kind: OsintTargetKind, value: string): OsintTarget => ({ kind, query, value });

    if (query.length === 0) return mk('username', '');

    // IP littérale, éventuellement entre crochets pour l'IPv6.
    const bare = query.replace(/^\[|\]$/g, '');
    if (isIpv4(bare)) return mk('ip', bare);
    if (isIpv6(bare)) return mk('ip', bare.toLowerCase());

    // Hôte extrait à la main : ce module est compilé sans lib DOM ni types
    // Node, `URL` n'y existe pas.
    const scheme = query.match(/^https?:\/\/([^/?#]+)/i);
    if (scheme) {
        const authority = scheme[1];
        // Retire les identifiants (`user:pass@`) puis le port.
        const host = authority.slice(authority.lastIndexOf('@') + 1).replace(/:\d+$/, '');
        const hostBare = host.replace(/^\[|\]$/g, '');
        if (isIpv4(hostBare) || isIpv6(hostBare)) return mk('ip', hostBare.toLowerCase());
        if (DOMAIN.test(host)) return mk('url', host.toLowerCase().replace(/^www\./, ''));
    }

    if (EMAIL.test(query)) return mk('email', query.toLowerCase());

    const phone = phoneDigits(query);
    // Sans indicatif, seule une saisie franchement téléphonique compte : un
    // nombre de 6 chiffres est plus souvent un identifiant qu'un numéro.
    if (phone !== null && (phone.startsWith('+') || phone.length >= 9)) return mk('phone', phone);

    if (DOMAIN.test(query)) return mk('domain', query.toLowerCase().replace(/^www\./, ''));

    if (/\s/.test(query)) return mk('person', query.replace(/\s+/g, ' '));

    if (USERNAME.test(query)) return mk('username', query.replace(/^@/, '').toLowerCase());

    return mk('person', query);
}

/**
 * Le tarif d'une sonde. Sans clé, elle ne coûte rien ; avec, c'est celui du
 * fournisseur, sauf qu'une clé facultative n'ôte rien à l'usage gratuit.
 */
export function osintProbePricing(probe: OsintProbeId): OsintPricing {
    const key = OSINT_PROBE_META[probe].key;
    if (!key) return 'free';
    const pricing = OSINT_PROVIDER_META[key.provider].pricing;
    return key.mode === 'optional' && pricing === 'paid' ? 'freemium' : pricing;
}

/** La sonde peut-elle rendre quelque chose avec les clés que l'espace a posées ? */
export function osintProbeUsable(probe: OsintProbeId, held: ReadonlySet<OsintProvider>): boolean {
    const key = OSINT_PROBE_META[probe].key;
    return key?.mode !== 'required' || held.has(key.provider);
}

/** Quelles sondes s'appliquent à cette nature de cible. Miroir du registre serveur. */
export const OSINT_PROBES_BY_KIND: Record<OsintTargetKind, readonly OsintProbeId[]> = {
    domain: ['dns', 'rdap', 'whois', 'tls', 'http', 'crtsh', 'virustotal', 'dorks'],
    url: ['dns', 'rdap', 'whois', 'tls', 'http', 'crtsh', 'virustotal', 'dorks'],
    ip: ['ptr', 'rdapIp', 'geoip', 'blocklist', 'ports', 'virustotal', 'dorks'],
    email: ['email', 'gravatar', 'github', 'pgp', 'breaches', 'dorks'],
    phone: ['phone', 'dorks'],
    person: ['registry', 'deaths', 'wikidata', 'github', 'dorks'],
    username: ['username', 'github', 'keybase', 'gravatar', 'dorks']
};
