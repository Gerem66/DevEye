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

/** Défauts des quotas d'un site, tous réglables dans l'onglet de leur section. */
export const AUDIENCE_SUBMISSION_IP_QUOTA_DEFAULT = 5;
export const AUDIENCE_FORM_HOURLY_QUOTA_DEFAULT = 200;
/** `0` = illimité : aucun site en place ne doit se mettre à perdre des vues. */
export const AUDIENCE_EVENT_IP_QUOTA_DEFAULT = 0;
export const AUDIENCE_QUOTA_MAX = 100_000;

/** L'origine qui accepte tout, par opposition à la liste vide qui n'accepte rien. */
export const AUDIENCE_ORIGIN_ANY = '*';

/**
 * Les vues et événements du mois face à l'offre du propriétaire de l'espace.
 * `used` peut dépasser `limit` : une offre qui baisse ne retire rien d'écrit.
 */
export const audienceEventsQuotaSchema = z.object({
    limit: z.number().int().nonnegative(),
    used: z.number().int().nonnegative()
});
export type AudienceEventsQuota = z.infer<typeof audienceEventsQuotaSchema>;

export const AUDIENCE_RETENTION_MIN_DAYS = 7;
export const AUDIENCE_RETENTION_MAX_DAYS = 730;
export const AUDIENCE_RETENTION_DEFAULT_DAYS = 90;

/** Événements acceptés dans un seul envoi. Borne le coût d'une requête publique. */
export const AUDIENCE_BATCH_MAX = 20;

/** Au-delà, une ligne du classement n'apprend plus rien et pèse un déchiffrement. */
export const AUDIENCE_BREAKDOWN_MAX = 50;
/** Ce qu'un classement montre d'emblée ; « Tout afficher » va jusqu'au plafond. */
export const AUDIENCE_BREAKDOWN_DEFAULT = 8;

/** Pages de transit déclarables sur un site : un écran de chargement, un accueil, une connexion. */
export const AUDIENCE_MAX_TRANSIT_PATHS = 20;

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
     * Les hôtes autorisés à écrire, et trois états plutôt que deux : **vide, rien
     * n'entre** ; `['*']`, tout entre ; sinon la liste (`exemple.fr`,
     * `www.exemple.fr`). Le vide refusait de refuser dans la première version,
     * ce qui faisait du défaut le réglage le plus permissif.
     */
    origins: z.array(z.string().max(AUDIENCE_ORIGIN_MAX_LENGTH)).max(AUDIENCE_MAX_ORIGINS),
    /** Éteint, plus rien n'entre ; l'historique déjà là ne bouge pas. */
    active: z.boolean(),
    /** Conservation des événements bruts. L'agrégat journalier, lui, survit. */
    retentionDays: z.number().int().min(AUDIENCE_RETENTION_MIN_DAYS).max(AUDIENCE_RETENTION_MAX_DAYS),
    /**
     * Accepter un nom de formulaire jamais déclaré, et le créer. Éteint par
     * défaut : allumé, quiconque lit la clé publique dans la page décide de ce
     * que l'écran affiche.
     */
    formsAuto: z.boolean(),
    /** Retours acceptés d'une même adresse vers un même formulaire, par heure. */
    submissionIpQuota: z.number().int().min(0).max(AUDIENCE_QUOTA_MAX),
    /** Retours par heure et par formulaire ; dépassé, le formulaire se ferme. */
    formHourlyQuota: z.number().int().min(0).max(AUDIENCE_QUOTA_MAX),
    /** Événements de mesure par adresse et par heure. `0` = illimité. */
    eventIpQuota: z.number().int().min(0).max(AUDIENCE_QUOTA_MAX),
    /**
     * Les pages que le taux de rebond ne compte pas : un écran de chargement,
     * un accueil ou une connexion par lesquels toute visite passe avant sa
     * première vraie page. Une visite qui n'a vu que celles-là, ou une seule
     * autre, est un rebond. Elles restent comptées partout ailleurs (vues,
     * classement, durée). Normalisées comme les chemins reçus.
     */
    transitPaths: z.array(z.string().max(AUDIENCE_LABEL_MAX_LENGTH)).max(AUDIENCE_MAX_TRANSIT_PATHS),
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

// --------------------------------------------------------------- retours

/**
 * Les retours : la seconde façon dont un site entre ici. La mesure regarde ce
 * que les visiteurs font ; un retour est ce qu'ils écrivent.
 *
 * Un **formulaire** est le canal nommé qui les reçoit (`contact`,
 * `sondage-2026`), et il se **déclare**, avec ses champs et leur type. Le
 * laisser naître de sa première réception, comme la première version le
 * faisait, donnait à qui lit la clé publique dans la page le pouvoir de faire
 * apparaître vingt canaux et autant de colonnes dans le tableau : ce n'est pas
 * une commodité, c'est une interface qu'on prête à un inconnu. Le mode `auto`
 * reste offert par formulaire, et un interrupteur de site rouvre la création à
 * la volée, tous deux éteints par défaut.
 *
 * Le type déclaré ne sert pas qu'à refuser : un `<form>` HTML n'envoie que des
 * chaînes (`"4"`, `"on"`), et c'est lui qui les ramène à la bonne valeur avant
 * qu'on les range et qu'on les compte. C'est aussi lui qui laisse engendrer le
 * formulaire à coller, et montrer une question déclarée que personne n'a
 * remplie, ce qu'un comptage seul ne peut pas savoir.
 *
 * Le chiffrement pose le même problème qu'aux statistiques, et reçoit la même
 * réponse : la charge utile est chiffrée **en bloc** (personne n'agrège dessus),
 * et ce sur quoi on compte est **haché** dans `ft_audience_form_labels`, les
 * compteurs de `ft_audience_answers` ne portant que des identifiants entiers.
 * Une répartition se lit donc sans ouvrir une seule clé.
 */

export const AUDIENCE_FORM_NAME_MAX_LENGTH = 64;

/**
 * Formulaires par site, déclarés comme créés à la volée. Borne aussi ce qu'un
 * site en mode `auto` peut faire apparaître : sans elle, une clé publique
 * connue suffirait à remplir la table de canaux tirés au sort.
 */
export const AUDIENCE_MAX_FORMS = 20;

/** Champs déclarables sur un formulaire. */
export const AUDIENCE_FORM_FIELDS_MAX = 40;

/** Choix possibles d'un champ fermé. Au-delà, ce n'est plus une question fermée. */
export const AUDIENCE_FIELD_CHOICES_MAX = 30;

export const AUDIENCE_SUBMISSION_FIELDS_MAX = 40;
export const AUDIENCE_FIELD_NAME_MAX_LENGTH = 64;

/** Ce qu'on conserve d'une réponse. Généreux : un message en est une. */
export const AUDIENCE_FIELD_VALUE_MAX_LENGTH = 4096;

/** Éléments d'une réponse à choix multiples. */
export const AUDIENCE_FIELD_VALUES_MAX = 20;

/**
 * Au-delà, une réponse n'est plus un choix mais un texte : elle rejoint le seau
 * « texte libre » du champ, qui n'en garde que le nombre. Compter les
 * occurrences d'un message de contact ne dirait rien et ferait une ligne de
 * dimension par visiteur.
 */
export const AUDIENCE_ANSWER_VALUE_MAX_LENGTH = 60;

/**
 * Valeurs distinctes indexées par champ. Le dépassement est le signe qu'on
 * n'avait pas affaire à une question fermée : le champ bascule alors
 * définitivement au seau, ce qui borne la cardinalité sans rien demander à
 * personne.
 */
export const AUDIENCE_ANSWER_VALUES_MAX = 50;

/**
 * Retours conservés par formulaire. Un plafond, jamais une rétention : une
 * visite est jetable, un message ne l'est pas, et l'effacer en silence au bout
 * de N jours perdrait ce que l'utilisateur avait demandé à collecter.
 *
 * Garde de stockage seulement, et surtout pas la seule borne : atteint, il
 * condamnerait le formulaire jusqu'à ce qu'on le vide, ce qui offrirait un déni
 * de service à qui connaît la clé. C'est le quota horaire ci-dessous qui arrête
 * une rafale, en fermant le formulaire de façon datée et réversible.
 */
export const AUDIENCE_FORM_SUBMISSIONS_MAX = 50_000;

/** Lignes rendues par page de tableau. */
export const AUDIENCE_SUBMISSION_PAGE = 100;

/**
 * Ce qu'une réponse peut valoir. Fermé volontairement : un objet imbriqué se
 * range sans problème mais ne se met pas dans une colonne de tableau, et
 * l'accepter promettrait un affichage qu'on ne saurait pas tenir.
 */
export const audienceFieldValueSchema = z.union([
    z.string().max(AUDIENCE_FIELD_VALUE_MAX_LENGTH),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(z.string().max(AUDIENCE_FIELD_VALUE_MAX_LENGTH)).max(AUDIENCE_FIELD_VALUES_MAX)
]);
export type AudienceFieldValue = z.infer<typeof audienceFieldValueSchema>;

export const audienceFieldsSchema = z
    .record(z.string().min(1).max(AUDIENCE_FIELD_NAME_MAX_LENGTH), audienceFieldValueSchema)
    .refine((fields) => Object.keys(fields).length <= AUDIENCE_SUBMISSION_FIELDS_MAX, {
        message: `Un retour ne peut pas porter plus de ${AUDIENCE_SUBMISSION_FIELDS_MAX} champs.`
    });

/** Un retour tel qu'un site l'envoie, quelle que soit la forme de la requête. */
export const audienceSubmitSchema = z.object({
    key: z.string().length(AUDIENCE_PUBLIC_KEY_LENGTH),
    form: z.string().min(1).max(AUDIENCE_FORM_NAME_MAX_LENGTH),
    fields: audienceFieldsSchema,
    /** La page d'où part le retour, pour le retrouver dans son contexte. */
    path: z.string().max(AUDIENCE_LABEL_MAX_LENGTH).optional(),
    /** Comme pour la mesure : relie le retour à la visite, en mode persistant. */
    visitorId: z.string().max(AUDIENCE_VISITOR_ID_MAX_LENGTH).optional()
});
export type AudienceSubmitBody = z.infer<typeof audienceSubmitSchema>;

/**
 * Le type d'un champ déclaré. Fermé, et court : chaque entrée doit répondre à
 * « comment ramener une chaîne de formulaire HTML à une valeur », et un type de
 * plus qu'on ne saurait pas convertir ne servirait qu'à décorer l'écran.
 */
export const audienceFieldKindSchema = z.enum(['text', 'email', 'number', 'boolean', 'choice']);
export type AudienceFieldKind = z.infer<typeof audienceFieldKindSchema>;

export const audienceFormFieldSchema = z
    .object({
        name: z.string().min(1).max(AUDIENCE_FIELD_NAME_MAX_LENGTH),
        kind: audienceFieldKindSchema,
        /** Absent d'un envoi, il le fait refuser en entier. */
        required: z.boolean(),
        /** `choice` seulement : les réponses admises, et rien d'autre. */
        choices: z.array(z.string().min(1).max(AUDIENCE_ANSWER_VALUE_MAX_LENGTH)).max(AUDIENCE_FIELD_CHOICES_MAX),
        /** `choice` seulement : plusieurs cases cochables. */
        multiple: z.boolean()
    })
    .refine((field) => field.kind !== 'choice' || field.choices.length > 0, {
        message: 'Un champ à choix doit proposer au moins une réponse.'
    })
    .refine((field) => field.kind === 'choice' || (field.choices.length === 0 && !field.multiple), {
        message: 'Seul un champ à choix porte des réponses possibles.'
    });
export type AudienceFormField = z.infer<typeof audienceFormFieldSchema>;

/**
 * Comment un formulaire traite ce qu'il reçoit.
 *
 * `strict` : l'envoi est confronté aux champs déclarés, et refusé en entier
 * s'il n'y colle pas. C'est le défaut d'un formulaire créé à l'écran.
 *
 * `auto` : tout est accepté et les colonnes se découvrent. Utile quand le site
 * évolue plus vite que ses réglages, au prix de laisser un inconnu qui a la clé
 * publique décider de ce qu'on affiche.
 */
export const audienceFormModeSchema = z.enum(['strict', 'auto']);
export type AudienceFormMode = z.infer<typeof audienceFormModeSchema>;

/** Les champs déclarés d'un formulaire, ou aucun en mode `auto`. */
export const audienceFormFieldsSchema = z.array(audienceFormFieldSchema).max(AUDIENCE_FORM_FIELDS_MAX);

/**
 * Pourquoi un formulaire s'est fermé tout seul. `quota` = une rafale a dépassé
 * le quota horaire du site ; `full` = le plafond de stockage est atteint. La
 * réouverture est un geste manuel, pour qu'on regarde ce qui est entré avant.
 */
export const audienceFormClosureSchema = z.enum(['quota', 'full']);
export type AudienceFormClosure = z.infer<typeof audienceFormClosureSchema>;

export const audienceFormSchema = z.object({
    id: z.number().int().positive(),
    name: z.string().max(AUDIENCE_FORM_NAME_MAX_LENGTH),
    mode: audienceFormModeSchema,
    fields: audienceFormFieldsSchema,
    /** Fermé, plus rien n'entre ; ce qui est déjà là ne bouge pas. */
    open: z.boolean(),
    /**
     * Quand et pourquoi il s'est fermé tout seul. `null` sur un formulaire
     * ouvert, ou fermé à la main : l'écran ne raconte une rafale que s'il y en a
     * eu une.
     */
    closedAt: z.number().int().nullable(),
    closedReason: audienceFormClosureSchema.nullable(),
    submissions: z.number().int().nonnegative(),
    lastAt: z.number().int().nullable(),
    created: z.number().int()
});
export type AudienceForm = z.infer<typeof audienceFormSchema>;

/**
 * La visite d'où vient un retour, quand on a su la retrouver. `null` pour un
 * envoi serveur, un visiteur inactif depuis longtemps, ou une session déjà
 * expirée : c'est un bonus de contexte, jamais une donnée du retour lui-même.
 */
export const audienceSubmissionContextSchema = z.object({
    entryPath: z.string(),
    referrer: z.string(),
    browser: z.string(),
    device: z.string()
});
export type AudienceSubmissionContext = z.infer<typeof audienceSubmissionContextSchema>;

export const audienceSubmissionSchema = z.object({
    id: z.number().int().positive(),
    at: z.number().int(),
    fields: audienceFieldsSchema,
    /** La page d'envoi, vide si le client ne l'a pas donnée. */
    path: z.string(),
    context: audienceSubmissionContextSchema.nullable()
});
export type AudienceSubmission = z.infer<typeof audienceSubmissionSchema>;

/**
 * La répartition d'un champ. `free` est le seau « texte libre » : des réponses
 * bien reçues, comptées, mais dont la valeur n'a pas été indexée. L'écran le
 * dit plutôt que de faire croire qu'elles n'existent pas.
 */
export const audienceResultFieldSchema = z.object({
    name: z.string(),
    /**
     * Le type déclaré, ou `null` sur un champ découvert en mode `auto`. C'est
     * lui qui distingue « personne n'a répondu à cette question » de « cette
     * question n'existe pas », qu'un comptage seul confond.
     */
    kind: audienceFieldKindSchema.nullable(),
    answered: z.number().int().nonnegative(),
    free: z.number().int().nonnegative(),
    values: z.array(z.object({ label: z.string(), count: z.number().int().nonnegative() }))
});
export type AudienceResultField = z.infer<typeof audienceResultFieldSchema>;

export const audienceResultsSchema = z.object({
    total: z.number().int().nonnegative(),
    fields: z.array(audienceResultFieldSchema)
});
export type AudienceResults = z.infer<typeof audienceResultsSchema>;

// ------------------------------------------------------------- le sommaire

/**
 * Ce que la fiche d'un site montre avant qu'on choisisse quoi regarder : trois
 * cartes, trois lectures indépendantes. Une seule commande pour les trois, le
 * sommaire n'ayant jamais de raison d'en afficher deux sur trois.
 */
export const audienceSummarySchema = z.object({
    traffic: z.object({
        views24h: z.number().int().nonnegative(),
        visitors24h: z.number().int().nonnegative(),
        /** Sept points venus de l'agrégat journalier, qui survit à la rétention. */
        days: z.array(z.object({ day: z.number().int(), views: z.number().int().nonnegative() }))
    }),
    funnels: z.object({
        count: z.number().int().nonnegative(),
        /**
         * Le premier entonnoir seulement. Les mesurer tous coûterait une requête
         * de rétention par entonnoir pour une carte qu'on ne fait que survoler.
         */
        first: z.object({ name: z.string(), rate: z.number().min(0).max(1) }).nullable()
    }),
    feedback: z.object({
        forms: z.number().int().nonnegative(),
        submissions: z.number().int().nonnegative(),
        last7d: z.number().int().nonnegative(),
        lastAt: z.number().int().nullable()
    })
});
export type AudienceSummary = z.infer<typeof audienceSummarySchema>;

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
     * Hôtes autorisés, séparés par des sauts de ligne, ou `*` pour tout
     * accepter. `NULL` ne laisse plus rien entrer. En clair pour la même raison
     * que la clé, et publics de toute façon puisqu'ils nomment les pages où la
     * balise est posée.
     */
    origins: string | null;
    active: number;
    retention_days: number;
    forms_auto: number;
    submission_ip_quota: number;
    form_hourly_quota: number;
    event_ip_quota: number;
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

/**
 * Un formulaire : le canal nommé qui reçoit les retours d'un site. `submissions`
 * et `last_at` sont dénormalisés parce que le sommaire et la liste les lisent
 * sans jamais ouvrir la table des retours, qui est la grosse.
 */
export interface AudienceFormRow {
    id: number;
    site_id: number;
    /** Condensé du nom en minuscules : porte l'unicité dans le site. */
    name_ref: string;
    /** 'strict' | 'auto'. */
    mode: string;
    /** { fields } chiffré ; `NULL` sur un formulaire en mode auto. */
    form_schema: string | null;
    /** Fermé, plus rien n'entre. */
    is_open: number;
    closed_at: number | null;
    /** 'quota' | 'full', ou `NULL` quand la fermeture est un geste humain. */
    closed_reason: string | null;
    submissions: number;
    last_at: number | null;
    sort_order: number;
    /** { name } chiffré, étage ouvert. */
    content: string;
    created: number;
}

export interface AudienceSubmissionRow {
    id: number;
    form_id: number;
    /** Dénormalisé : compter les retours d'un site ne demande pas de jointure. */
    site_id: number;
    ts: number;
    /**
     * Condensé de l'adresse avec le sel du jour, jamais l'adresse : de quoi
     * compter les envois d'une même provenance sans en conserver aucune.
     */
    ip_ref: string;
    /** La visite d'où il vient, `NULL` dès que la rétention l'a purgée. */
    session_id: number | null;
    /** { fields, path } chiffré, en bloc : rien ne s'agrège dessus. */
    content: string;
}

/**
 * Un nom de champ ou une valeur de réponse, chiffré et dédoublonné par son
 * condensé. Même rôle qu'`audience_labels` pour la mesure, mais rattaché au
 * formulaire : deux formulaires d'un même site posent rarement les mêmes
 * questions, et les mélanger ferait des compteurs partagés à tort.
 */
export interface AudienceFormLabelRow {
    id: number;
    form_id: number;
    /** 'field' | 'value'. */
    kind: string;
    label_ref: string;
    content: string;
}

/**
 * Combien de fois cette réponse a été donnée à cette question. Incrémenté à la
 * réception : une répartition se lit alors sans déchiffrer quoi que ce soit.
 * `value_id = 0` est le seau « texte libre », qui ne pointe aucun libellé.
 */
export interface AudienceAnswerRow {
    form_id: number;
    field_id: number;
    value_id: number;
    hits: number;
}
