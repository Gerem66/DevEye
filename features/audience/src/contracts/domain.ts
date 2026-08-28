import { z } from 'zod';
import { projectStatusSchema } from '@deveye/types';

/**
 * L'audience d'un espace : ce que les gens font des projets une fois livrés.
 *
 * Même renversement que pour les dépôts git et les bases de données : un **site
 * suivi** appartient à l'espace, pas à un projet, et plusieurs projets peuvent
 * pointer le même. Il vit donc à l'étage **ouvert** du chiffrement — un projet
 * confidentiel ne peut pas en lier.
 *
 * ## Pourquoi si peu de choses sont chiffrées ici
 *
 * Une statistique est un `GROUP BY`. Rien de ce sur quoi on agrège ne peut donc
 * être chiffré, le chiffrement étant non déterministe. La sortie est celle que
 * le dépôt emploie déjà — les colonnes `*_ref` — poussée jusqu'à une **table de
 * dimensions** : `audience_labels` porte le libellé chiffré, et tout le reste ne
 * manipule que son identifiant entier. On agrège sans clé, on ne déchiffre que
 * les quelques dizaines de libellés effectivement affichés.
 *
 * Restent **en clair** sur le site lui-même sa clé publique, ses origines
 * autorisées, son état et sa plateforme : ce sont exactement les champs dont
 * l'ingestion a besoin pour router une requête *sans session ni clé*, et la clé
 * comme les origines sont de toute façon lisibles dans la page suivie.
 *
 * ## Aucun cookie, aucun identifiant persistant
 *
 * Un visiteur est un condensé `(clé du site, IP, user-agent, sel du jour)` : ni
 * l'IP ni le user-agent ne sont stockés, et l'identifiant ne traverse pas les
 * jours. Rien à faire accepter par un bandeau de consentement.
 *
 * Le « par qui » nominatif vient d'ailleurs, et seulement si le site le veut :
 * un `identity` que **lui** envoie pour ses propres utilisateurs connectés.
 */

export const AUDIENCE_SITE_NAME_MAX_LENGTH = 96;
export const AUDIENCE_SITE_DESCRIPTION_MAX_LENGTH = 500;
export const AUDIENCE_ORIGIN_MAX_LENGTH = 255;
export const AUDIENCE_MAX_ORIGINS = 20;

/**
 * Longueur d'un libellé de dimension : un chemin, un référent, un nom
 * d'événement. Généreuse pour les chemins, qui portent parfois une requête
 * entière — c'est le serveur qui tronque, jamais le client.
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
 * Marches d'un entonnoir, et entonnoirs par site.
 *
 * Dix marches est déjà beaucoup : au-delà, la lecture d'un entonnoir devient un
 * exercice de comptage plutôt qu'un coup d'œil. La borne sert aussi de garde
 * technique — le nombre de marches entre dans la **forme** de la requête de
 * rétention, et une borne connue est ce qui rend cette construction sûre.
 */
export const AUDIENCE_FUNNEL_MAX_STEPS = 10;
export const AUDIENCE_MAX_FUNNELS = 20;

/**
 * Inactivité au-delà de laquelle une nouvelle visite ouvre une **autre**
 * session. Trente minutes est la convention du domaine ; ce qui compte est
 * surtout qu'elle soit unique et connue, puisque la durée moyenne et le taux de
 * rebond en découlent tous les deux.
 */
export const AUDIENCE_SESSION_GAP_SECONDS = 30 * 60;

/**
 * Ce qu'un site est capable d'envoyer, et donc ce qu'on est en droit d'exiger
 * de lui.
 *
 * `web` — une page dans un navigateur : elle envoie un en-tête `Origin`, qui est
 * confronté à la liste des origines autorisées.
 * `app` — un client natif (React Native, binaire) : il n'en envoie aucun, la
 * confrontation est donc désactivée pour ce site.
 * `both` — les deux voies pour un même produit ; l'`Origin`, quand il est
 * présent, doit être autorisé, mais son absence n'est pas un refus.
 *
 * ⚠️ À dire franchement : la clé d'un site `app` est extractible du binaire, et
 * seuls elle et le plafond de débit le protègent. Il n'existe pas mieux sans
 * imposer un compte utilisateur à chaque visiteur.
 */
export const audiencePlatformSchema = z.enum(['web', 'app', 'both']);
export type AudiencePlatform = z.infer<typeof audiencePlatformSchema>;

/**
 * Comment un visiteur est reconnu. C'est le seul réglage de la feature qui
 * change ce que la mesure *est*, et non ce qu'elle affiche.
 *
 * `anonymous` (défaut) : un condensé de l'IP, du user-agent et d'un sel qui
 * tourne chaque jour. Rien n'est écrit chez le visiteur, donc rien à faire
 * accepter. Le prix est qu'une même personne revenant le lendemain compte pour
 * une nouvelle, ce qui rend « visiteurs récurrents » impossible par
 * construction.
 *
 * `persistent` : le site range un identifiant tiré au sort dans le stockage du
 * navigateur et le renvoie à chaque mesure. La même personne est alors reconnue
 * d'un jour à l'autre, ce qui ouvre les visiteurs connus et le nombre de
 * visites par personne.
 *
 * ⚠️ **Ce mode relève du consentement.** Écrire un identifiant durable chez le
 * visiteur, que ce soit un cookie ou du `localStorage`, tombe sous la directive
 * ePrivacy exactement de la même façon. L'interface le dit à l'endroit où on
 * l'active ; il appartient au site de recueillir ce consentement avant de poser
 * `data-visitor="persistent"` sur sa balise.
 *
 * Les deux côtés doivent être d'accord : le serveur ignore un identifiant reçu
 * si le site est en `anonymous`, et la balise n'en envoie aucun sans son
 * attribut. Éteindre le réglage suffit donc à revenir en arrière, sans toucher
 * aux pages.
 */
export const audienceVisitorModeSchema = z.enum(['anonymous', 'persistent']);
export type AudienceVisitorMode = z.infer<typeof audienceVisitorModeSchema>;

/** Longueur maximale de l'identifiant qu'un client persistant peut proposer. */
export const AUDIENCE_VISITOR_ID_MAX_LENGTH = 64;

/**
 * Les axes selon lesquels on peut ventiler.
 *
 * **Un seul vocabulaire pour deux usages** : c'est à la fois le `kind` d'une
 * ligne d'`audience_labels` et l'axe demandé par `audience.breakdown`. Les
 * séparer aurait produit deux listes à garder synchrones à la main, pour
 * exactement le même ensemble de valeurs.
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
    /** Le fuseau déclaré par le client (`Europe/Paris`) — pas un pays. */
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
    /** Combien de projets s'en servent — l'interconnexion, comme pour un dépôt. */
    projectCount: z.number().int().nonnegative(),
    /**
     * Cet élément vient d'un **autre espace**, qui le projette ici.
     *
     * L'écran le signale d'une pastille : sans elle, rien ne distingue une
     * ligne locale d'une fenêtre sur l'espace voisin — et les gestes réservés
     * au domicile (supprimer, re-partager) sembleraient cassés au lieu de
     * s'expliquer.
     */
    foreign: z.boolean(),
    created: z.number().int()
});
export type AudienceSite = z.infer<typeof audienceSiteSchema>;

/**
 * Un projet qui suit ce site.
 *
 * Ne remonte que des projets à l'étage ouvert — un projet confidentiel ne peut
 * pas être lié, donc le titre est toujours lisible sans session. Même forme que
 * `DatabaseUsage` et `GitRepoUsage`, pour que les trois écrans se ressemblent.
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
     * Visiteurs déjà venus avant la période.
     *
     * Toujours `0` en mode anonyme : personne n'y est jamais reconnu d'un jour
     * à l'autre, et afficher une part de récurrents serait mentir. Ne remonte
     * donc que sur un site en mode persistant, et l'écran ne montre la tuile
     * que dans ce cas.
     *
     * ⚠️ Borné par la conservation du site : quelqu'un dont la dernière visite
     * a expiré repasse pour un nouveau. C'est une conséquence de la rétention,
     * pas une erreur de comptage.
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
 * Le bandeau d'un site, et la courbe dessous.
 *
 * `previous` porte les **mêmes** mesures sur la fenêtre précédente de même
 * longueur. C'est ce qui transforme un nombre en information : « 1 240 vues »
 * ne dit rien, « 1 240 vues, +18 % » dit s'il faut regarder de plus près. Le
 * coût est la même requête sur une fenêtre décalée, ce qui est peu cher payé.
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
 * Une case de la carte d'activité : un jour de la semaine, une heure.
 *
 * L'heure est **locale au visiteur**, reconstituée depuis le décalage qu'il a
 * déclaré. C'est la seule qui réponde à « quand mes utilisateurs sont-ils là ? » :
 * en heure serveur, une audience répartie sur trois continents ne dessine rien.
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
    /** Les fuseaux les plus représentés — la « zone de temps » la plus active. */
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
 * Ce qu'une marche reconnaît.
 *
 * `path` — une page vue. `event` — un événement nommé, posé par le site avec
 * `deveye.event('…')`.
 *
 * Ce sont exactement deux des dimensions déjà collectées, et c'est tout l'objet
 * du découpage : **le site émet des signaux, l'entonnoir se compose ici**. Sans
 * lui, mesurer autre chose demanderait de redéployer le site.
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
 * Un événement tel qu'un client l'envoie.
 *
 * **Rien ici ne suppose un navigateur** : aucun champ propre au web n'est
 * requis, `path` désigne une route *ou* un écran, et les trois champs
 * d'appareil peuvent être renseignés explicitement par un client natif qui les
 * connaît, au lieu d'être devinés d'un user-agent qu'il n'a pas. C'est ce qui
 * permettra à un module React Native de se brancher sans toucher au serveur.
 *
 * Tout est optionnel sauf le type et le chemin : un client qui ne sait pas
 * remplir un champ doit pouvoir l'omettre, jamais mentir.
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
     * L'identifiant que le client garde d'une visite à l'autre.
     *
     * Ignoré si le site n'est pas en mode persistant. Jamais stocké tel quel :
     * le serveur n'en garde qu'un condensé, propre au site, pour qu'un même
     * identifiant sur deux sites ne permette aucun recoupement.
     */
    visitorId: z.string().max(AUDIENCE_VISITOR_ID_MAX_LENGTH).optional(),
    browser: z.string().max(64).optional(),
    os: z.string().max(64).optional(),
    device: z.string().max(32).optional(),
    /**
     * Horodatage client, en secondes epoch — pour un client natif qui a mis des
     * événements de côté hors ligne. Le serveur le **borne** à sa propre
     * fenêtre : une horloge fausse ne doit pas pouvoir dater une visite de 2038
     * et écraser tous les graphes de l'espace.
     */
    at: z.number().int().optional()
});
export type AudienceEventInput = z.infer<typeof audienceEventInputSchema>;

export const audienceIngestSchema = z.object({
    key: z.string().length(AUDIENCE_PUBLIC_KEY_LENGTH),
    /**
     * Porté par le lot et non par chaque événement : c'est une propriété du
     * client, pas de la mesure. Le répéter vingt fois dans une trame aurait
     * coûté plus que tout le reste du corps.
     */
    visitorId: z.string().max(AUDIENCE_VISITOR_ID_MAX_LENGTH).optional(),
    events: z.array(audienceEventInputSchema).min(1).max(AUDIENCE_BATCH_MAX)
});
export type AudienceIngestBody = z.infer<typeof audienceIngestSchema>;

// ------------------------------------------------------------- lignes SQL

export interface AudienceSiteRow {
    id: number;
    workspace_id: number;
    /**
     * En clair : c'est la seule chose dont l'ingestion dispose pour retrouver le
     * site, et elle tourne sans session ni clé.
     */
    public_key: string;
    /** Condensé du nom en minuscules : porte l'unicité dans l'espace. */
    name_ref: string;
    platform: string;
    /** 'anonymous' | 'persistent'. En clair : l'ingestion s'en sert sans clé. */
    visitor_mode: string;
    /**
     * Hôtes autorisés, séparés par des sauts de ligne. En clair pour la même
     * raison que la clé — et ils sont publics de toute façon, puisqu'ils
     * nomment les pages où la balise est posée.
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
 * Un libellé de dimension, chiffré, dédoublonné par son condensé.
 *
 * C'est la table qui rend tout le reste possible : un chemin vu mille fois est
 * stocké **une** fois, et les tables de faits ne portent que son `id`.
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
 * L'agrégat journalier. **Jamais purgé** — c'est lui qui fait survivre les
 * courbes longues à l'expiration des événements bruts, exactement comme
 * l'agrégat journalier d'Uptime.
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
     * Condensé de la valeur reconnue — le **même** que celui d'`audience_labels`,
     * ce qui permet de retrouver le libellé sans jamais déchiffrer pour
     * comparer.
     *
     * Une marche peut parfaitement ne correspondre à aucun libellé : c'est le
     * cas d'un événement qu'on a prévu mais que le site n'a encore jamais posé.
     * Elle compte alors zéro, ce qui est la vérité.
     */
    label_ref: string;
    /** La valeur lisible, chiffrée : la marche se décrit toute seule. */
    content: string;
}
