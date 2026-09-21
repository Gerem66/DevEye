import { z } from 'zod';
import {
    AUDIENCE_BREAKDOWN_MAX,
    AUDIENCE_FORM_NAME_MAX_LENGTH,
    AUDIENCE_QUOTA_MAX,
    AUDIENCE_FUNNEL_MAX_STEPS,
    AUDIENCE_FUNNEL_NAME_MAX_LENGTH,
    AUDIENCE_LABEL_MAX_LENGTH,
    AUDIENCE_MAX_ORIGINS,
    AUDIENCE_MAX_TRANSIT_PATHS,
    AUDIENCE_ORIGIN_MAX_LENGTH,
    AUDIENCE_RETENTION_MAX_DAYS,
    AUDIENCE_RETENTION_MIN_DAYS,
    AUDIENCE_SITE_DESCRIPTION_MAX_LENGTH,
    AUDIENCE_SITE_NAME_MAX_LENGTH,
    AUDIENCE_SUBMISSION_PAGE,
    audienceActivitySchema,
    audienceBreakdownItemSchema,
    audienceDimensionSchema,
    audienceFormFieldsSchema,
    audienceFormModeSchema,
    audienceFormSchema,
    audienceFunnelSchema,
    audienceFunnelStepDraftSchema,
    audienceLiveSchema,
    audienceOverviewSchema,
    audiencePlatformSchema,
    audienceRangeSchema,
    audienceResultsSchema,
    audienceSubmissionSchema,
    audienceSummarySchema,
    audienceVisitorModeSchema,
    audienceEventsQuotaSchema,
    audienceSiteSchema,
    audienceUsageSchema
} from './domain';

/**
 * Commandes de l'audience d'un espace, sous le préfixe unique `audience.` et en
 * camelCase derrière le point. Conséquence : le filet de démarrage
 * (`MUTATION_VERB`) cherche un verbe juste après le point et ne reconnaît aucune
 * de ces commandes, donc un `mutates` oublié ne produit aucun avertissement.
 *
 * Rien de ce qu'un site envoie n'entre par une commande, ni la mesure ni les
 * retours : tout passe par HTTP sans session (`routes.ts`), et ces commandes ne
 * font que lire ce qui a été écrit, déclarer les sites et régler les canaux.
 *
 * L'espace visé n'apparaît dans aucune entrée : il voyage sur l'enveloppe WS et
 * le dispatcheur le résout, appartenance vérifiée, avant le handler.
 */

const siteId = z.number().int().positive();

/** Ce qu'on peut régler sur un site — identique à l'ajout et à la modification. */
const siteBody = {
    name: z.string().min(1).max(AUDIENCE_SITE_NAME_MAX_LENGTH),
    description: z.string().max(AUDIENCE_SITE_DESCRIPTION_MAX_LENGTH),
    platform: audiencePlatformSchema,
    visitorMode: audienceVisitorModeSchema,
    /**
     * Les hôtes autorisés à écrire. Le client envoie des hôtes nus ou des
     * origines complètes : le serveur normalise, parce que c'est lui qui compare.
     */
    origins: z.array(z.string().max(AUDIENCE_ORIGIN_MAX_LENGTH)).max(AUDIENCE_MAX_ORIGINS),
    active: z.boolean(),
    retentionDays: z.number().int().min(AUDIENCE_RETENTION_MIN_DAYS).max(AUDIENCE_RETENTION_MAX_DAYS),
    formsAuto: z.boolean(),
    submissionIpQuota: z.number().int().min(0).max(AUDIENCE_QUOTA_MAX),
    formHourlyQuota: z.number().int().min(0).max(AUDIENCE_QUOTA_MAX),
    eventIpQuota: z.number().int().min(0).max(AUDIENCE_QUOTA_MAX),
    /** Un chemin par entrée, tel que saisi : le serveur normalise et dédoublonne. */
    transitPaths: z.array(z.string().max(AUDIENCE_LABEL_MAX_LENGTH)).max(AUDIENCE_MAX_TRANSIT_PATHS)
};

// ------------------------------------------------------------------ sites

/** Le nombre de sites de l'espace, pour la tuile de l'accueil. */
export const audienceCount = {
    command: 'audience.count' as const,
    input: z.object({}),
    output: z.object({ count: z.number().int().nonnegative() })
};

/** Les sites de l'espace, dans l'ordre de l'utilisateur. */
export const audienceList = {
    command: 'audience.list' as const,
    input: z.object({}),
    /** `eventsQuota` à `null` : aucune offre ne borne les vues de cet espace. */
    output: z.object({ sites: z.array(audienceSiteSchema), eventsQuota: audienceEventsQuotaSchema.nullable() })
};

/**
 * Un site, avec les projets qui le suivent et l'adresse de sa balise.
 * `ingestOrigin` vient du serveur et non de l'origine du navigateur :
 * l'application est derrière le VPN alors que l'ingestion doit être joignable
 * sans lui, donc les deux adresses diffèrent par construction.
 */
export const audienceGet = {
    command: 'audience.get' as const,
    input: z.object({ siteId }),
    output: z.object({
        site: audienceSiteSchema,
        usage: z.array(audienceUsageSchema),
        ingestOrigin: z.string()
    })
};

/**
 * Déclare un site. La clé publique est engendrée par le serveur : la laisser
 * choisir permettrait de viser celle d'un site d'un autre espace.
 */
export const audienceSiteAdd = {
    command: 'audience.siteAdd' as const,
    input: z.object(siteBody),
    output: z.object({ site: audienceSiteSchema })
};

export const audienceSiteUpdate = {
    command: 'audience.siteUpdate' as const,
    input: z.object({ siteId, ...siteBody }),
    output: z.object({ site: audienceSiteSchema })
};

/**
 * Supprime un site et tout son historique : rien ne s'archive ici, garder des
 * millions d'événements orphelins ne servirait personne. Les liaisons de projet
 * tombent avec (`CASCADE`), les projets eux-mêmes ne bougent pas.
 */
export const audienceSiteRemove = {
    command: 'audience.siteRemove' as const,
    input: z.object({ siteId }),
    output: z.object({ ok: z.literal(true) })
};

/**
 * Renouvelle la clé publique, quand une clé s'est retrouvée là où elle n'aurait
 * pas dû. L'ancienne cesse d'entrer immédiatement ; l'historique déjà collecté
 * reste, il a été mesuré.
 */
export const audienceSiteRotateKey = {
    command: 'audience.siteRotateKey' as const,
    input: z.object({ siteId }),
    output: z.object({ site: audienceSiteSchema })
};

export const audienceReorder = {
    command: 'audience.reorder' as const,
    input: z.object({ siteIds: z.array(siteId).min(1) }),
    output: z.object({ ok: z.literal(true) })
};

// ------------------------------------------------------------ statistiques

/** Le bandeau, la comparaison à la période précédente, et la courbe. */
export const audienceOverview = {
    command: 'audience.overview' as const,
    input: z.object({ siteId, range: audienceRangeSchema }),
    output: audienceOverviewSchema
};

/**
 * Un classement sur l'axe demandé. Une commande pour les neuf axes plutôt que
 * neuf commandes : ils rendent la même forme, se lisent par la même requête, et
 * neuf entrées auraient divergé au premier ajustement.
 */
export const audienceBreakdown = {
    command: 'audience.breakdown' as const,
    input: z.object({
        siteId,
        range: audienceRangeSchema,
        dimension: audienceDimensionSchema,
        limit: z.number().int().min(1).max(AUDIENCE_BREAKDOWN_MAX).optional()
    }),
    output: z.object({ items: z.array(audienceBreakdownItemSchema) })
};

/** La carte jour × heure, en heure **locale du visiteur**, et les fuseaux. */
export const audienceActivity = {
    command: 'audience.activity' as const,
    input: z.object({ siteId, range: audienceRangeSchema }),
    output: audienceActivitySchema
};

/**
 * Qui est là en ce moment (cinq dernières minutes). Séparée de `overview` : elle
 * est minuscule et se relit souvent, la faire voyager avec le bandeau
 * obligerait à recalculer tout l'agrégat pour rafraîchir un compteur.
 */
export const audienceLive = {
    command: 'audience.live' as const,
    input: z.object({ siteId }),
    output: audienceLiveSchema
};

// ------------------------------------------------------------ entonnoirs

const funnelId = z.number().int().positive();

/** Les marches, dans l'ordre. Un entonnoir d'une seule marche n'en est pas un. */
const steps = z.array(audienceFunnelStepDraftSchema).min(2).max(AUDIENCE_FUNNEL_MAX_STEPS);

/**
 * Les entonnoirs d'un site, avec leurs chiffres sur la fenêtre demandée.
 * Définitions et mesures dans la même réponse : l'écran n'affiche jamais l'une
 * sans l'autre, et les séparer ferait deux allers-retours pour un seul dessin.
 */
export const audienceFunnelList = {
    command: 'audience.funnelList' as const,
    input: z.object({ siteId, range: audienceRangeSchema }),
    output: z.object({ funnels: z.array(audienceFunnelSchema) })
};

/**
 * Définit un entonnoir à partir de ce que le site a déjà émis : mesurer un
 * autre parcours ne demande aucun redéploiement.
 */
export const audienceFunnelAdd = {
    command: 'audience.funnelAdd' as const,
    input: z.object({
        siteId,
        name: z.string().min(1).max(AUDIENCE_FUNNEL_NAME_MAX_LENGTH),
        steps
    }),
    output: z.object({ funnelId })
};

export const audienceFunnelUpdate = {
    command: 'audience.funnelUpdate' as const,
    input: z.object({
        funnelId,
        name: z.string().min(1).max(AUDIENCE_FUNNEL_NAME_MAX_LENGTH),
        steps
    }),
    output: z.object({ ok: z.literal(true) })
};

/**
 * Supprime un entonnoir. Aucune mesure n'est perdue : un entonnoir n'est qu'une
 * lecture des événements déjà là, et le recréer rendrait les mêmes chiffres.
 */
export const audienceFunnelRemove = {
    command: 'audience.funnelRemove' as const,
    input: z.object({ funnelId }),
    output: z.object({ ok: z.literal(true) })
};

// ------------------------------------------------------------- sommaire

/**
 * Les trois cartes de la fiche d'un site, en un aller-retour. Le sommaire ne
 * montre jamais l'une sans les autres, et trois commandes auraient fait trois
 * attentes pour un seul écran.
 */
export const audienceSummary = {
    command: 'audience.summary' as const,
    input: z.object({ siteId }),
    output: audienceSummarySchema
};

// -------------------------------------------------------------- retours

const formId = z.number().int().positive();

/** Les formulaires d'un site, avec ce qu'ils ont reçu. */
export const audienceFormList = {
    command: 'audience.formList' as const,
    input: z.object({ siteId }),
    output: z.object({ forms: z.array(audienceFormSchema) })
};

/**
 * Déclare un formulaire, ses champs et leur type. C'est la voie normale : le
 * laisser naître d'une réception donne à qui lit la clé publique le pouvoir de
 * décider des colonnes qu'on affiche, et il faut que le site l'ait autorisé
 * (`formsAuto`) pour que cela reste possible.
 *
 * Comme les autres écritures du module, celle-ci et ses voisines battent le
 * sujet `audience` (`mutates: true`), qui ravive les cinq clés de cache. Les
 * écrans ravivent en plus `audience.forms` sur place, sans attendre
 * l'aller-retour.
 */
export const audienceFormAdd = {
    command: 'audience.formAdd' as const,
    input: z.object({
        siteId,
        name: z.string().min(1).max(AUDIENCE_FORM_NAME_MAX_LENGTH),
        mode: audienceFormModeSchema,
        fields: audienceFormFieldsSchema
    }),
    output: z.object({ form: audienceFormSchema })
};

/**
 * Renomme un formulaire, redéfinit ses champs, ferme ou rouvre sa porte.
 *
 * Le nom fait partie de l'adressage : le changer ici veut dire le changer dans
 * le site, sinon l'ancien nom se présentera comme un inconnu. Les champs, eux,
 * ne valent que pour ce qui entre **ensuite** : les retours déjà reçus ne sont
 * pas relus à l'aune du nouveau schéma, et c'est ce qui rend une correction
 * sans danger.
 */
export const audienceFormUpdate = {
    command: 'audience.formUpdate' as const,
    input: z.object({
        formId,
        name: z.string().min(1).max(AUDIENCE_FORM_NAME_MAX_LENGTH),
        mode: audienceFormModeSchema,
        fields: audienceFormFieldsSchema,
        open: z.boolean()
    }),
    output: z.object({ form: audienceFormSchema })
};

/**
 * Vide un formulaire de ses retours, en gardant le canal ouvert. Les compteurs
 * de répartition tombent avec eux : ils ne décrivent que ce qui est là.
 */
export const audienceFormClear = {
    command: 'audience.formClear' as const,
    input: z.object({ formId }),
    output: z.object({ removed: z.number().int().nonnegative() })
};

/**
 * Supprime le formulaire et tout ce qu'il a reçu. Le même nom réapparaîtra au
 * prochain envoi du site : fermer est ce qui empêche d'entrer, supprimer ne
 * fait qu'effacer.
 */
export const audienceFormRemove = {
    command: 'audience.formRemove' as const,
    input: z.object({ formId }),
    output: z.object({ ok: z.literal(true) })
};

/**
 * Une page de retours, du plus récent au plus ancien ou l'inverse. Le curseur
 * porte `(ts, id)` : un `OFFSET` sauterait ou répéterait une ligne dès qu'un
 * retour arrive pendant la lecture.
 *
 * Ni recherche ni tri par colonne ici : la charge utile est chiffrée, SQL n'a
 * rien à quoi les appliquer. Le tableau les fait sur ce qu'il a chargé, et le
 * dit.
 */
export const audienceSubmissionList = {
    command: 'audience.submissionList' as const,
    input: z.object({
        formId,
        order: z.enum(['recent', 'oldest']).default('recent'),
        cursor: z.string().max(64).nullable().optional(),
        limit: z.number().int().min(1).max(AUDIENCE_SUBMISSION_PAGE).optional()
    }),
    output: z.object({
        submissions: z.array(audienceSubmissionSchema),
        /** `null` = il n'y a plus rien après. */
        nextCursor: z.string().nullable()
    })
};

export const audienceSubmissionRemove = {
    command: 'audience.submissionRemove' as const,
    input: z.object({ submissionId: z.number().int().positive() }),
    output: z.object({ ok: z.literal(true) })
};

/**
 * La répartition des réponses, champ par champ. Lue dans les compteurs tenus à
 * la réception, donc sans déchiffrer un seul retour : seuls les quelques
 * dizaines de libellés affichés sont ouverts.
 */
export const audienceResults = {
    command: 'audience.results' as const,
    input: z.object({ formId }),
    output: audienceResultsSchema
};

export const audienceCommands = [
    audienceCount,
    audienceList,
    audienceGet,
    audienceSiteAdd,
    audienceSiteUpdate,
    audienceSiteRemove,
    audienceSiteRotateKey,
    audienceReorder,
    audienceOverview,
    audienceBreakdown,
    audienceActivity,
    audienceLive,
    audienceFunnelList,
    audienceFunnelAdd,
    audienceFunnelUpdate,
    audienceFunnelRemove,
    audienceSummary,
    audienceFormList,
    audienceFormAdd,
    audienceFormUpdate,
    audienceFormClear,
    audienceFormRemove,
    audienceSubmissionList,
    audienceSubmissionRemove,
    audienceResults
] as const;
