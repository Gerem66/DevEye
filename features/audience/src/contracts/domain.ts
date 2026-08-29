import { z } from 'zod';
import { projectStatusSchema } from '@deveye/types';

/**
 * L'audience d'un espace : ce que les gens font des projets une fois livrés.
 *
 * Un site suivi appartient à l'espace et non à un projet, plusieurs projets
 * peuvent pointer le même, et il vit donc à l'étage ouvert du chiffrement.
 *
 * Une statistique est un `GROUP BY` : rien de ce sur quoi on agrège ne peut être
 * chiffré, le chiffrement étant non déterministe. D'où la table de dimensions,
 * `audience_labels`, qui porte le libellé chiffré pendant que tout le reste ne
 * manipule que son identifiant entier ; on ne déchiffre que les quelques
 * dizaines de libellés affichés. Restent en clair sur le site sa clé publique,
 * ses origines, son état et sa plateforme : les champs dont l'ingestion a besoin
 * pour router une requête sans session ni clé, et qui sont de toute façon
 * lisibles dans la page suivie.
 *
 * Un visiteur est un condensé `(clé du site, IP, user-agent, sel du jour)` : ni
 * l'IP ni le user-agent ne sont stockés, et l'identifiant ne traverse pas les
 * jours. Le « par qui » nominatif vient d'ailleurs, et seulement si le site le
 * veut : un `identity` que lui envoie pour ses utilisateurs connectés.
 */

export const AUDIENCE_SITE_NAME_MAX_LENGTH = 96;
export const AUDIENCE_SITE_DESCRIPTION_MAX_LENGTH = 500;
export const AUDIENCE_ORIGIN_MAX_LENGTH = 255;
export const AUDIENCE_MAX_ORIGINS = 20;

/**
 * Longueur d'un libellé de dimension (chemin, référent, nom d'événement),
 * généreuse pour les chemins ; c'est le serveur qui tronque, jamais le client.
 */
export const AUDIENCE_LABEL_MAX_LENGTH = 512;

/** `pk_` + 24 caractères. Publique par nature : elle est dans la page suivie. */
export const AUDIENCE_PUBLIC_KEY_LENGTH = 27;

export const AUDIENCE_RETENTION_MIN_DAYS = 7;
export const AUDIENCE_RETENTION_MAX_DAYS = 730;
export const AUDIENCE_RETENTION_DEFAULT_DAYS = 180;

/** Événements acceptés dans un seul envoi. Borne le coût d'une requête publique. */
export const AUDIENCE_BATCH_MAX = 20;

/** Au-delà, une ligne du classement n'apprend plus rien et pèse un déchiffrement. */
export const AUDIENCE_BREAKDOWN_MAX = 50;

export const AUDIENCE_FUNNEL_NAME_MAX_LENGTH = 96;

/**
 * Marches d'un entonnoir, et entonnoirs par site. La borne sert aussi de garde
 * technique : le nombre de marches entre dans la forme de la requête de
 * rétention, et une borne connue est ce qui rend cette construction sûre.
 */
export const AUDIENCE_FUNNEL_MAX_STEPS = 10;
export const AUDIENCE_MAX_FUNNELS = 20;

/**
 * Inactivité au-delà de laquelle une visite ouvre une autre session. Trente
 * minutes est la convention du domaine ; ce qui compte est qu'elle soit unique
 * et connue, la durée moyenne et le taux de rebond en découlant tous deux.
 */
export const AUDIENCE_SESSION_GAP_SECONDS = 30 * 60;

/**
 * Ce qu'un site est capable d'envoyer, et donc ce qu'on peut exiger de lui.
 *
 * `web` : une page dans un navigateur, dont l'`Origin` est confronté à la liste
 * des origines autorisées. `app` : un client natif, qui n'en envoie aucun, donc
 * la confrontation est désactivée. `both` : l'`Origin` présent doit être
 * autorisé, mais son absence n'est pas un refus.
 *
 * La clé d'un site `app` est extractible du binaire, et seuls elle et le
 * plafond de débit le protègent : il n'existe pas mieux sans imposer un compte
 * utilisateur à chaque visiteur.
 */
export const audiencePlatformSchema = z.enum(['web', 'app', 'both']);
export type AudiencePlatform = z.infer<typeof audiencePlatformSchema>;

/**
 * Comment un visiteur est reconnu : le seul réglage de la feature qui change ce
 * que la mesure est, et non ce qu'elle affiche.
 *
 * `anonymous` (défaut) : un condensé de l'IP, du user-agent et d'un sel qui
 * tourne chaque jour. Rien n'est écrit chez le visiteur, au prix qu'une même
 * personne revenant le lendemain compte pour une nouvelle.
 *
 * `persistent` : le site range un identifiant tiré au sort dans le stockage du
 * navigateur, ce qui ouvre les visiteurs connus. Ce mode relève du consentement,
 * `localStorage` tombant sous la directive ePrivacy comme un cookie, et c'est au
 * site de le recueillir avant de poser l'attribut sur sa balise.
 *
 * Les deux côtés doivent être d'accord : le serveur ignore un identifiant reçu
 * si le site est en `anonymous`, et la balise n'en envoie aucun sans son
 * attribut, donc éteindre le réglage suffit à revenir en arrière.
 */
export const audienceVisitorModeSchema = z.enum(['anonymous', 'persistent']);
export type AudienceVisitorMode = z.infer<typeof audienceVisitorModeSchema>;

/** Longueur maximale de l'identifiant qu'un client persistant peut proposer. */
export const AUDIENCE_VISITOR_ID_MAX_LENGTH = 64;

/**
 * Les axes selon lesquels on peut ventiler : un seul vocabulaire pour le `kind`
 * d'une ligne d'`audience_labels` et pour l'axe demandé par `audience.breakdown`,
 * les séparer aurait produit deux listes à garder synchrones à la main.
 */
export const audienceDimensionSchema = z.enum([
    /** Le chemin de la page, ou le nom de l'écran d'un client natif. */
    'path',
    /** D'où vient le visiteur ; l'hôte seul, jamais l'URL complète. */
    'referrer',
    'browser',
    'os',
    /** `desktop` | `mobile` | `tablet`, déduit du user-agent ou envoyé tel quel. */
    'device',
    /** Le fuseau déclaré par le client (`Europe/Paris`), pas un pays. */
    'timezone',
    'language',
    /** Le nom d'un événement nommé (`inscription`, `paiement`…). */
    'event',
    /** Ce que le site suivi appelle son utilisateur, quand il le déclare. */
    'identity'
]);
export type AudienceDimension = z.infer<typeof audienceDimensionSchema>;

export const AUDIENCE_DIMENSIONS = audienceDimensionSchema.options;

/** Fenêtres offertes. Fermées exprès : chacune a sa résolution et ses index. */
export const audienceRangeSchema = z.enum(['24h', '7d', '30d', '90d', '365d']);
export type AudienceRange = z.infer<typeof audienceRangeSchema>;

/** Le pas d'une courbe, déduit de la fenêtre et jamais choisi par l'appelant. */
export const audienceResolutionSchema = z.enum(['hour', 'day', 'week']);
export type AudienceResolution = z.infer<typeof audienceResolutionSchema>;

// ----------------------------------------------------------------- le site

export const audienceSiteSchema = z.object({
    id: z.number().int().positive(),
    /** Le nom que lui donne l'utilisateur ; porte l'unicité dans l'espace. */
    name: z.string().max(AUDIENCE_SITE_NAME_MAX_LENGTH),
    description: z.string().max(AUDIENCE_SITE_DESCRIPTION_MAX_LENGTH),
    /**
     * La clé à coller dans la page. **Publique**, et c'est assumé : elle ne
     * protège rien, ce sont les origines autorisées qui filtrent.
     */
    publicKey: z.string().length(AUDIENCE_PUBLIC_KEY_LENGTH),
    platform: audiencePlatformSchema,
    visitorMode: audienceVisitorModeSchema,
    /**
     * Les hôtes autorisés à écrire (`exemple.fr`, `www.exemple.fr`). Vide = on
     * accepte n'importe quelle origine, ce que l'écran signale comme un état
     * transitoire — le temps de brancher, pas un réglage à laisser en place.
     */
    origins: z.array(z.string().max(AUDIENCE_ORIGIN_MAX_LENGTH)).max(AUDIENCE_MAX_ORIGINS),
    /** Éteint, plus rien n'entre ; l'historique déjà là ne bouge pas. */
    active: z.boolean(),
    /** Conservation des événements bruts. L'agrégat journalier, lui, survit. */
    retentionDays: z.number().int().min(AUDIENCE_RETENTION_MIN_DAYS).max(AUDIENCE_RETENTION_MAX_DAYS),
    /**
     * Quand le dernier événement est entré. `null` = jamais rien reçu, ce qui
     * est l'état normal d'un site qu'on vient de déclarer et non une panne :
     * c'est ce que l'écran d'installation attend pour se déclarer satisfait.
     */
    lastEventAt: z.number().int().nullable(),
    /** De quoi ranger la liste sans ouvrir chaque fiche. */
    views24h: z.number().int().nonnegative(),
    visitors24h: z.number().int().nonnegative(),
    /** Combien de projets s'en servent, pour l'interconnexion. */
    projectCount: z.number().int().nonnegative(),
    /**
     * Cet élément vient d'un autre espace, qui le projette ici. L'écran le
     * signale d'une pastille, sans quoi les gestes réservés au domicile
     * sembleraient cassés au lieu de s'expliquer.
     */
    foreign: z.boolean(),
    created: z.number().int()
});
export type AudienceSite = z.infer<typeof audienceSiteSchema>;

/**
 * Un projet qui suit ce site. Ne remonte que des projets à l'étage ouvert, un
 * projet confidentiel ne pouvant pas être lié : le titre est donc toujours
 * lisible sans session.
 */
export const audienceUsageSchema = z.object({
    projectId: z.number().int().positive(),
    title: z.string(),
    status: projectStatusSchema
});
export type AudienceUsage = z.infer<typeof audienceUsageSchema>;

// ------------------------------------------------------------ ce qu'on lit

export const audienceMetricsSchema = z.object({
    views: z.number().int().nonnegative(),
    visitors: z.number().int().nonnegative(),
    sessions: z.number().int().nonnegative(),
    /** Durée moyenne d'une session, en secondes. */
    avgDurationSeconds: z.number().nonnegative(),
    /** Part des sessions d'une seule vue, entre 0 et 1. */
    bounceRate: z.number().min(0).max(1),
    /**
     * Visiteurs déjà venus avant la période. Toujours `0` en mode anonyme, où
     * personne n'est reconnu d'un jour à l'autre : l'écran ne montre la tuile
     * que sur un site persistant. Borné par la conservation du site, quelqu'un
     * dont la dernière visite a expiré repassant pour un nouveau.
     */
    returningVisitors: z.number().int().nonnegative()
});
export type AudienceMetrics = z.infer<typeof audienceMetricsSchema>;

export const audiencePointSchema = z.object({
    /** Début du seau, en secondes epoch. */
    at: z.number().int(),
    views: z.number().int().nonnegative(),
    visitors: z.number().int().nonnegative()
});
export type AudiencePoint = z.infer<typeof audiencePointSchema>;

/**
 * Le bandeau d'un site, et la courbe dessous. `previous` porte les mêmes
 * mesures sur la fenêtre précédente de même longueur, ce qui transforme un
 * nombre en information : « 1 240 vues » ne dit rien, « +18 % » si.
 */
export const audienceOverviewSchema = z.object({
    metrics: audienceMetricsSchema,
    previous: audienceMetricsSchema,
    resolution: audienceResolutionSchema,
    points: z.array(audiencePointSchema)
});
export type AudienceOverview = z.infer<typeof audienceOverviewSchema>;

export const audienceBreakdownItemSchema = z.object({
    /** Le libellé déchiffré, vide si le blob est illisible. */
    label: z.string(),
    views: z.number().int().nonnegative(),
    visitors: z.number().int().nonnegative()
});
export type AudienceBreakdownItem = z.infer<typeof audienceBreakdownItemSchema>;

/**
 * Une case de la carte d'activité : un jour de la semaine, une heure. L'heure
 * est locale au visiteur, reconstituée depuis le décalage qu'il a déclaré ; en
 * heure serveur, une audience répartie sur trois continents ne dessine rien.
 */
export const audienceActivityCellSchema = z.object({
    /** 0 = lundi. Semaine à l'européenne, comme le reste de l'interface. */
    day: z.number().int().min(0).max(6),
    hour: z.number().int().min(0).max(23),
    views: z.number().int().nonnegative()
});
export type AudienceActivityCell = z.infer<typeof audienceActivityCellSchema>;

export const audienceActivitySchema = z.object({
    cells: z.array(audienceActivityCellSchema),
    /** Les fuseaux les plus représentés, la « zone de temps » la plus active. */
    timezones: z.array(audienceBreakdownItemSchema)
});
export type AudienceActivity = z.infer<typeof audienceActivitySchema>;

/** Qui est là en ce moment. Lu souvent, donc volontairement minuscule. */
export const audienceLiveSchema = z.object({
    visitors: z.number().int().nonnegative(),
    pages: z.array(audienceBreakdownItemSchema)
});
export type AudienceLive = z.infer<typeof audienceLiveSchema>;

// ------------------------------------------------------------ entonnoirs

/**
 * Ce qu'une marche reconnaît : `path`, une page vue, ou `event`, un événement
 * nommé posé par le site. Deux des dimensions déjà collectées, et c'est l'objet
 * du découpage : le site émet des signaux, l'entonnoir se compose ici, sans
 * quoi mesurer autre chose demanderait de redéployer le site.
 */
export const audienceFunnelStepKindSchema = z.enum(['path', 'event']);
export type AudienceFunnelStepKind = z.infer<typeof audienceFunnelStepKindSchema>;

/** Une marche telle qu'on la définit : ce qu'elle reconnaît, et rien d'autre. */
export const audienceFunnelStepDraftSchema = z.object({
    kind: audienceFunnelStepKindSchema,
    value: z.string().min(1).max(AUDIENCE_LABEL_MAX_LENGTH)
});
export type AudienceFunnelStepDraft = z.infer<typeof audienceFunnelStepDraftSchema>;

/** Une marche telle qu'on la lit : sa définition, et ce qu'elle a mesuré. */
export const audienceFunnelStepSchema = audienceFunnelStepDraftSchema.extend({
    /** Visites arrivées jusqu'ici, les marches précédentes franchies dans l'ordre. */
    sessions: z.number().int().nonnegative()
});
export type AudienceFunnelStep = z.infer<typeof audienceFunnelStepSchema>;

export const audienceFunnelSchema = z.object({
    id: z.number().int().positive(),
    name: z.string().max(AUDIENCE_FUNNEL_NAME_MAX_LENGTH),
    steps: z.array(audienceFunnelStepSchema)
});
export type AudienceFunnel = z.infer<typeof audienceFunnelSchema>;

// --------------------------------------------------------- l'ingestion

/**
 * Un événement tel qu'un client l'envoie. Rien ici ne suppose un navigateur :
 * `path` désigne une route ou un écran, et les champs d'appareil peuvent être
 * renseignés par un client natif au lieu d'être devinés d'un user-agent qu'il
 * n'a pas. Tout est optionnel sauf le type et le chemin : un client qui ne sait
 * pas remplir un champ doit pouvoir l'omettre, jamais mentir.
 */
export const audienceEventInputSchema = z.object({
    type: z.enum(['view', 'event']),
    path: z.string().min(1).max(AUDIENCE_LABEL_MAX_LENGTH),
    /** Requis pour un `event`, ignoré pour une `view`. */
    name: z.string().max(AUDIENCE_LABEL_MAX_LENGTH).optional(),
    /** URL complète ; le serveur n'en garde que l'hôte. */
    referrer: z.string().max(AUDIENCE_LABEL_MAX_LENGTH).optional(),
    /** `Intl.DateTimeFormat().resolvedOptions().timeZone`. */
    timezone: z.string().max(64).optional(),
    /** Décalage local en minutes, tel que `getTimezoneOffset()` le rend. */
    tzOffset: z.number().int().min(-840).max(840).optional(),
    screenWidth: z.number().int().min(0).max(20000).optional(),
    language: z.string().max(35).optional(),
    /** Ce que le site appelle son utilisateur connecté. Chiffré au repos. */
    identity: z.string().max(AUDIENCE_LABEL_MAX_LENGTH).optional(),
    /**
     * L'identifiant que le client garde d'une visite à l'autre, ignoré si le
     * site n'est pas en mode persistant. Jamais stocké tel quel : le serveur
     * n'en garde qu'un condensé propre au site, pour interdire tout recoupement.
     */
    visitorId: z.string().max(AUDIENCE_VISITOR_ID_MAX_LENGTH).optional(),
    browser: z.string().max(64).optional(),
    os: z.string().max(64).optional(),
    device: z.string().max(32).optional(),
    /**
     * Horodatage client, en secondes epoch, pour un client natif qui a mis des
     * événements de côté hors ligne. Le serveur le borne à sa propre fenêtre :
     * une horloge fausse ne doit pas dater une visite de 2038.
     */
    at: z.number().int().optional()
});
export type AudienceEventInput = z.infer<typeof audienceEventInputSchema>;

export const audienceIngestSchema = z.object({
    key: z.string().length(AUDIENCE_PUBLIC_KEY_LENGTH),
    /**
     * Porté par le lot et non par chaque événement : c'est une propriété du
     * client, pas de la mesure.
     */
    visitorId: z.string().max(AUDIENCE_VISITOR_ID_MAX_LENGTH).optional(),
    events: z.array(audienceEventInputSchema).min(1).max(AUDIENCE_BATCH_MAX)
});
export type AudienceIngestBody = z.infer<typeof audienceIngestSchema>;

// ------------------------------------------------------------- lignes SQL

export interface AudienceSiteRow {
    id: number;
    workspace_id: number;
    /** En clair : la seule chose dont l'ingestion, sans session ni clé, dispose. */
    public_key: string;
    /** Condensé du nom en minuscules : porte l'unicité dans l'espace. */
    name_ref: string;
    platform: string;
    /** 'anonymous' | 'persistent'. En clair : l'ingestion s'en sert sans clé. */
    visitor_mode: string;
    /**
     * Hôtes autorisés, séparés par des sauts de ligne. En clair pour la même
     * raison que la clé, et publics de toute façon puisqu'ils nomment les pages
     * où la balise est posée.
     */
    origins: string | null;
    active: number;
    retention_days: number;
    sort_order: number;
    last_event_at: number | null;
    /** { name, description } chiffré, étage ouvert. */
    content: string;
    created: number;
}

/**
 * Un libellé de dimension, chiffré et dédoublonné par son condensé : un chemin
 * vu mille fois est stocké une fois, et les tables de faits ne portent que son
 * `id`.
 */
export interface AudienceLabelRow {
    id: number;
    site_id: number;
    /** Une valeur d'`audienceDimensionSchema`. */
    kind: string;
    /** 16 premiers caractères du sha256 de la valeur normalisée. */
    label_ref: string;
    content: string;
}

export interface AudienceSessionRow {
    id: number;
    site_id: number;
    /** sha256(clé du site + IP + user-agent + sel du jour), tronqué. */
    visitor_ref: string;
    started_at: number;
    last_at: number;
    views: number;
    entry_path_id: number | null;
    referrer_id: number | null;
    browser_id: number | null;
    os_id: number | null;
    device_id: number | null;
    timezone_id: number | null;
    language_id: number | null;
    identity_id: number | null;
    /** Décalage local du visiteur, en minutes. Sert la carte d'activité. */
    tz_offset: number | null;
    screen_width: number | null;
}

export interface AudienceEventRow {
    id: number;
    site_id: number;
    session_id: number;
    ts: number;
    /** 0 = vue de page, 1 = événement nommé. */
    kind: number;
    path_id: number | null;
    name_id: number | null;
}

/**
 * L'agrégat journalier, jamais purgé : c'est lui qui fait survivre les courbes
 * longues à l'expiration des événements bruts.
 */
export interface AudienceDailyRow {
    site_id: number;
    /** Jour UTC, en `YYYYMMDD`. Un entier se compare et s'indexe. */
    day: number;
    views: number;
    sessions: number;
    visitors: number;
}

export interface AudienceFunnelRow {
    id: number;
    site_id: number;
    /** Condensé du nom : porte l'unicité de l'entonnoir dans son site. */
    name_ref: string;
    sort_order: number;
    /** { name } chiffré, étage ouvert. */
    content: string;
    created: number;
}

export interface AudienceFunnelStepRow {
    id: number;
    funnel_id: number;
    site_id: number;
    position: number;
    /** Une valeur d'`audienceFunnelStepKindSchema`. */
    match_kind: string;
    /**
     * Condensé de la valeur reconnue, le même que celui d'`audience_labels` :
     * on retrouve le libellé sans jamais déchiffrer pour comparer. Une marche
     * peut ne correspondre à aucun libellé (un événement prévu que le site n'a
     * jamais posé) et compte alors zéro, ce qui est la vérité.
     */
    label_ref: string;
    /** La valeur lisible, chiffrée : la marche se décrit toute seule. */
    content: string;
}
