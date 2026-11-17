import { z } from 'zod';
import { projectStatusSchema } from '@deveye/types';

/**
 * Les apps qu'un espace suit sur l'App Store et sur Google Play. Tout vit à
 * l'étage ouvert : le service de fond relit les stores sans session. Les
 * mesures restent en clair parce qu'on les agrège ; les noms, les identifiants
 * au store, les avis et les clés sont chiffrés.
 */

export const APPSTORES_APP_NAME_MAX_LENGTH = 80;
export const APPSTORES_SOURCE_LABEL_MAX_LENGTH = 80;
/** Un JSON de compte de service pèse environ 2,4 Ko, un `.p8` 250 octets. */
export const APPSTORES_SECRET_MAX_LENGTH = 8192;
export const APPSTORES_REVIEW_PAGE_MAX = 100;

/** Les limites des stores pour une réponse publique, en caractères. */
export const APPSTORES_REPLY_MAX_LENGTH = { apple: 5970, google: 350 } as const;

/** Ce que le premier passage va rechercher, et ce que l'on garde des avis. */
export const APPSTORES_BACKFILL_DAYS = 365;
export const APPSTORES_REVIEWS_KEEP_DAYS = 365;
export const APPSTORES_REVIEWS_MAX_PER_STORE = 5000;

/**
 * Les seuils de « mauvais comportement » de Google Play, sur la moyenne des 28
 * derniers jours des taux perçus. Au-delà, Google peut réduire la visibilité de
 * l'app et prévenir sur sa fiche.
 */
export const APPSTORES_CRASH_THRESHOLD = 0.0109;
export const APPSTORES_ANR_THRESHOLD = 0.0047;
export const APPSTORES_VITALS_WINDOW_DAYS = 28;

export const appStoreSchema = z.enum(['apple', 'google']);
export type AppStore = z.infer<typeof appStoreSchema>;
export const APP_STORES = appStoreSchema.options;

/**
 * Ce qu'une clé a su lire au dernier test. Les rôles d'Apple sont mal
 * documentés : on sonde au lieu de deviner, et un bloc que la clé ne couvre pas
 * le dit au lieu d'afficher des zéros. Répondre aux avis ne se sonde pas sans
 * écrire : cela se vérifie à la première réponse.
 */
export const appStoresCapabilitySchema = z.enum([
    'apps',
    'downloads',
    'ratings',
    'reviews',
    'revenue',
    'versions',
    'vitals'
]);
export type AppStoresCapability = z.infer<typeof appStoresCapabilitySchema>;
export const APPSTORES_CAPABILITIES = appStoresCapabilitySchema.options;

// ----------------------------------------------------------------- formats

/** Formats des identifiants qui entrent dans une URL de store : rien d'autre n'y passe. */
export const APPLE_ISSUER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const APPLE_KEY_ID = /^[A-Z0-9]{10}$/;
export const APPLE_VENDOR_NUMBER = /^\d{5,12}$/;
export const APPLE_APP_ID = /^\d{1,15}$/;
export const GOOGLE_BUCKET = /^pubsite_prod_(rev_)?\d+$/;
export const GOOGLE_PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
export const COUNTRY_CODE = /^[A-Z]{2}$/;

/** Un identifiant au store, selon le store. */
export function isStoreAppId(store: AppStore, value: string): boolean {
    return store === 'apple' ? APPLE_APP_ID.test(value) : GOOGLE_PACKAGE.test(value) && value.length <= 255;
}

// ----------------------------------------------------------------- les sources

export const appStoresSourceSchema = z.object({
    id: z.number().int().positive(),
    store: appStoreSchema,
    label: z.string(),
    /** Apple : de quoi reconnaître la clé dans App Store Connect. Aucun n'est un secret. */
    issuerId: z.string().nullable(),
    keyId: z.string().nullable(),
    vendorNumber: z.string().nullable(),
    /** Google : l'adresse du compte de service, et le bucket des rapports. */
    clientEmail: z.string().nullable(),
    bucket: z.string().nullable(),
    hasSecret: z.boolean(),
    capabilities: z.array(appStoresCapabilitySchema),
    checkedAt: z.number().int().nullable(),
    /** Depuis quand le store refuse la clé, et ce qu'il en dit ; `null` quand tout va bien. */
    failingSince: z.number().int().nullable(),
    failingError: z.string().nullable(),
    /** Les fiches de store qui s'en servent : ce qu'un retrait va couper. */
    useCount: z.number().int().nonnegative(),
    created: z.number().int()
});
export type AppStoresSource = z.infer<typeof appStoresSourceSchema>;

const label = z.string().trim().min(1).max(APPSTORES_SOURCE_LABEL_MAX_LENGTH);
const secret = z.string().min(1).max(APPSTORES_SECRET_MAX_LENGTH);

/** Une clé d'équipe App Store Connect : le `.p8` ne se télécharge qu'une fois chez Apple. */
export const appleSourceInputSchema = z.object({
    store: z.literal('apple'),
    label,
    issuerId: z.string().trim().regex(APPLE_ISSUER_ID),
    keyId: z.string().trim().regex(APPLE_KEY_ID),
    vendorNumber: z.string().trim().regex(APPLE_VENDOR_NUMBER),
    /** Le contenu du fichier `.p8`. Absent à la mise à jour : on garde celui en place. */
    privateKey: secret.optional()
});

/** Un compte de service Google, invité dans la Play Console. */
export const googleSourceInputSchema = z.object({
    store: z.literal('google'),
    label,
    /** Le nom du bucket des rapports, sans `gs://` ni chemin. */
    bucket: z.string().trim().regex(GOOGLE_BUCKET),
    /** Le texte du fichier JSON. Absent à la mise à jour : on garde celui en place. */
    serviceAccount: secret.optional()
});

export const appStoresSourceInputSchema = z.discriminatedUnion('store', [
    appleSourceInputSchema,
    googleSourceInputSchema
]);
export type AppStoresSourceInput = z.infer<typeof appStoresSourceInputSchema>;

/** Une app vue par une clé, lue chez le store à la demande, jamais en cache. */
export const appStoresStoreAppSchema = z.object({
    store: appStoreSchema,
    /** L'identifiant numérique d'Apple, ou le nom de paquet Android. */
    externalId: z.string(),
    name: z.string(),
    bundleId: z.string().nullable(),
    /** Déjà suivie dans l'espace : signalée plutôt que masquée. */
    known: z.boolean()
});
export type AppStoresStoreApp = z.infer<typeof appStoresStoreAppSchema>;

// ----------------------------------------------------------------- les apps

/** Une version telle qu'Apple la décrit, `state` étant la valeur brute d'`appVersionState`. */
export const appStoresVersionSchema = z.object({
    version: z.string(),
    state: z.string(),
    since: z.number().int().nullable()
});
export type AppStoresVersion = z.infer<typeof appStoresVersionSchema>;

/** Ce qui a fait échouer la dernière passe d'une fiche, à dire en deux mots : la phrase est à côté. */
export const appStoresSyncFailureSchema = z.enum(['key', 'access', 'missing', 'limited', 'down', 'other']);
export type AppStoresSyncFailure = z.infer<typeof appStoresSyncFailureSchema>;

/** La présence d'une app sur un store. */
export const appStoresListingSchema = z.object({
    store: appStoreSchema,
    sourceId: z.number().int().positive().nullable(),
    externalId: z.string(),
    /** Le nom de l'app chez le store, tel que relevé au dernier passage. */
    storeName: z.string().nullable(),
    bundleId: z.string().nullable(),
    /** Les dernières versions, la plus récente d'abord ; chez Google, celles de la piste de production. */
    versions: z.array(appStoresVersionSchema),
    /** La note moyenne et son nombre de notes (Apple : dans le pays de référence). */
    rating: z.number().nullable(),
    ratingCount: z.number().int().nonnegative().nullable(),
    /** Dernier jour complet relevé, en secondes epoch (minuit UTC) ; `null` avant le premier. */
    dataUntil: z.number().int().nullable(),
    lastSyncAt: z.number().int().nullable(),
    syncError: z.string().nullable(),
    /** Présent avec `syncError`, et seulement avec lui. */
    syncFailure: appStoresSyncFailureSchema.nullable(),
    /** Le premier relevé, ou une relecture de l'année, n'est pas allé au bout : les chiffres se complètent. */
    syncing: z.boolean()
});
export type AppStoresListing = z.infer<typeof appStoresListingSchema>;

export const appStoresAppSchema = z.object({
    id: z.number().int().positive(),
    name: z.string(),
    /** Le pays dont la note App Store est lue : Apple n'en donne pas de mondiale. */
    ratingCountry: z.string(),
    listings: z.array(appStoresListingSchema),
    projectCount: z.number().int().nonnegative(),
    /** Cet élément vient d'un autre espace, qui le projette ici. */
    foreign: z.boolean(),
    /** L'offre de son propriétaire le tient en pause : plus rien ne se synchronise. */
    planPaused: z.boolean(),
    created: z.number().int()
});
export type AppStoresApp = z.infer<typeof appStoresAppSchema>;

/** Ce que la liste montre sans ouvrir la fiche : les sept derniers jours connus et les sept d'avant. */
export const appStoresAppSummarySchema = z.object({
    app: appStoresAppSchema,
    downloads: z.number().int().nonnegative().nullable(),
    previousDownloads: z.number().int().nonnegative().nullable()
});
export type AppStoresAppSummary = z.infer<typeof appStoresAppSummarySchema>;

/** Un projet qui relie cette app ; à l'étage ouvert, donc lisible sans session. */
export const appStoresUsageSchema = z.object({
    projectId: z.number().int().positive(),
    title: z.string(),
    status: projectStatusSchema
});
export type AppStoresUsage = z.infer<typeof appStoresUsageSchema>;

/** La présence voulue sur un store, à la création ou dans l'onglet Général. */
export const appStoresListingInputSchema = z.object({
    sourceId: z.number().int().positive().nullable(),
    externalId: z.string().trim().min(1).max(255)
});
export type AppStoresListingInput = z.infer<typeof appStoresListingInputSchema>;

export const appStoresAppInputSchema = z.object({
    name: z.string().trim().min(1).max(APPSTORES_APP_NAME_MAX_LENGTH),
    ratingCountry: z.string().regex(COUNTRY_CODE),
    apple: appStoresListingInputSchema.nullable(),
    google: appStoresListingInputSchema.nullable()
});
export type AppStoresAppInput = z.infer<typeof appStoresAppInputSchema>;

// ----------------------------------------------------------------- les chiffres

/** Fenêtres offertes. Les stores comptent par jour : rien sous la journée. */
export const appStoresRangeSchema = z.enum(['7d', '30d', '90d', '365d']);
export type AppStoresRange = z.infer<typeof appStoresRangeSchema>;

/** Le pas d'une courbe, déduit de la fenêtre et jamais choisi par l'appelant. */
export const appStoresResolutionSchema = z.enum(['day', 'week']);
export type AppStoresResolution = z.infer<typeof appStoresResolutionSchema>;

/**
 * La fenêtre d'une lecture, en secondes epoch. Elle se termine au dernier jour
 * complet commun aux stores de l'app, et non à aujourd'hui : les stores
 * publient avec un ou deux jours de retard, et les derniers jours
 * ressembleraient sinon à une chute.
 */
export const appStoresWindowSchema = z.object({
    range: appStoresRangeSchema,
    resolution: appStoresResolutionSchema,
    from: z.number().int().nonnegative(),
    to: z.number().int().nonnegative(),
    bucket: z.number().int().positive(),
    /** Dernier jour complet, `null` tant qu'aucun store n'a rien rendu. */
    dataUntil: z.number().int().nullable(),
    /** La fenêtre précédente est-elle entièrement relevée ? Sinon, pas d'écart à montrer. */
    previousCovered: z.boolean()
});
export type AppStoresWindow = z.infer<typeof appStoresWindowSchema>;

/** Une valeur par store, `null` quand l'app n'y est pas ou que rien n'est relevé. */
const perStore = <T extends z.ZodTypeAny>(value: T) => z.object({ apple: value.nullable(), google: value.nullable() });

export const appStoresMetricsSchema = z.object({
    downloads: perStore(z.number().int().nonnegative()),
    /** La dernière note relevée dans la fenêtre. */
    rating: perStore(z.number().min(0).max(5)),
    /** Avis reçus pendant la fenêtre, tous stores. */
    reviews: z.number().int().nonnegative(),
    /** Google : taux perçus, pondérés par utilisateurs sur la fenêtre. */
    crashRate: z.number().nonnegative().nullable(),
    anrRate: z.number().nonnegative().nullable()
});
export type AppStoresMetrics = z.infer<typeof appStoresMetricsSchema>;

export const appStoresPointSchema = z.object({
    /** Début du seau, en secondes epoch. */
    at: z.number().int(),
    appleDownloads: z.number().int().nonnegative().nullable(),
    googleDownloads: z.number().int().nonnegative().nullable(),
    crashRate: z.number().nonnegative().nullable(),
    anrRate: z.number().nonnegative().nullable()
});
export type AppStoresPoint = z.infer<typeof appStoresPointSchema>;

/** Aucun montant ici : les revenus ont leur commande et leur permission. */
export const appStoresStatsSchema = appStoresWindowSchema.extend({
    metrics: appStoresMetricsSchema,
    previous: appStoresMetricsSchema,
    points: z.array(appStoresPointSchema),
    /** La période d'avant, seau par seau, alignée sur `points` : de quoi la comparer et amorcer une moyenne glissante. */
    previousPoints: z.array(appStoresPointSchema),
    /** Les avis reçus pendant la fenêtre, par note : l'indice 0 compte les avis à une étoile. */
    reviewStars: z.array(z.number().int().nonnegative()).length(5),
    /** Les premiers téléchargements de la fenêtre par pays, les plus nombreux d'abord. */
    countries: z.array(z.object({ country: z.string().regex(COUNTRY_CODE), downloads: z.number().int().positive() }))
});
export type AppStoresStats = z.infer<typeof appStoresStatsSchema>;

export const appStoresRevenueTotalSchema = z.object({
    store: appStoreSchema,
    currency: z.string(),
    amount: z.number(),
    /** `null` quand la fenêtre précédente n'est pas couverte. */
    previous: z.number().nullable(),
    units: z.number().int()
});
export type AppStoresRevenueTotal = z.infer<typeof appStoresRevenueTotalSchema>;

export const appStoresRevenuePointSchema = z.object({
    at: z.number().int(),
    store: appStoreSchema,
    currency: z.string(),
    amount: z.number()
});
export type AppStoresRevenuePoint = z.infer<typeof appStoresRevenuePointSchema>;

/**
 * Apple rend des produits nets, Google des ventes estimées avant sa
 * commission : les deux ne se somment pas, et chaque devise reste à part.
 */
export const appStoresRevenueSchema = appStoresWindowSchema.extend({
    totals: z.array(appStoresRevenueTotalSchema),
    points: z.array(appStoresRevenuePointSchema)
});
export type AppStoresRevenue = z.infer<typeof appStoresRevenueSchema>;

// ----------------------------------------------------------------- les avis

/** Apple publie une réponse après relecture : elle reste « en attente » jusque-là. */
export const appStoresReplyStateSchema = z.enum(['pending', 'published']);
export type AppStoresReplyState = z.infer<typeof appStoresReplyStateSchema>;

export const appStoresReviewSchema = z.object({
    id: z.number().int().positive(),
    store: appStoreSchema,
    rating: z.number().int().min(1).max(5),
    title: z.string(),
    body: z.string(),
    author: z.string(),
    territory: z.string().nullable(),
    appVersion: z.string().nullable(),
    createdAt: z.number().int(),
    reply: z
        .object({
            body: z.string(),
            at: z.number().int().nullable(),
            state: appStoresReplyStateSchema
        })
        .nullable()
});
export type AppStoresReview = z.infer<typeof appStoresReviewSchema>;

/** Curseur des avis, du plus récent au plus ancien. */
export const appStoresReviewCursorSchema = z.object({
    createdAt: z.number().int(),
    id: z.number().int().positive()
});
export type AppStoresReviewCursor = z.infer<typeof appStoresReviewCursorSchema>;

// ----------------------------------------------------------------- la vue d'ensemble

const appRef = { id: z.number().int().positive(), name: z.string() };

/**
 * Toutes les apps visibles d'un coup, sur une seule fenêtre. Ne se cumulent que
 * les téléchargements, les pays, les avis reçus et les revenus : une note ou un
 * taux de plantage moyen de plusieurs apps ne dirait rien, ils restent par app.
 */
export const appStoresOverviewSchema = appStoresStatsSchema.omit({ reviewStars: true }).extend({
    /** Les apps comptées, les plus téléchargées d'abord, avec leurs seaux alignés sur `points`. */
    apps: z.array(
        z.object({
            ...appRef,
            downloads: z.number().int().nonnegative().nullable(),
            points: z.array(z.number().int().nonnegative().nullable())
        })
    ),
    /** Les fiches laissées de côté : leurs chiffres se sont arrêtés bien avant ceux des autres. */
    left: z.array(z.object({ ...appRef, store: appStoreSchema, dataUntil: z.number().int() })),
    /** Les avis de la fenêtre restés sans réponse. */
    unanswered: z.number().int().nonnegative(),
    /** Les premiers d'entre eux, les plus mal notés puis les plus récents. */
    reviews: z.array(appStoresReviewSchema.extend({ app: z.object(appRef), replyable: z.boolean() })),
    /** Les apps au-dessus d'un seuil de Google, sur ses 28 derniers jours mesurés. */
    alerts: z.array(
        z.object({
            ...appRef,
            crashRate: z.number().nonnegative().nullable(),
            anrRate: z.number().nonnegative().nullable()
        })
    ),
    /** `null` sans le droit Revenus sur aucune app ; `partial` quand il manque sur certaines. */
    revenue: z.object({ totals: z.array(appStoresRevenueTotalSchema), partial: z.boolean() }).nullable()
});
export type AppStoresOverview = z.infer<typeof appStoresOverviewSchema>;
