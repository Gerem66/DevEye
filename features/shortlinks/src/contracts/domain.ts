import { z } from 'zod';

/** Le préfixe des liens sur les adresses de DevEye : `api.deveye.fr/l/k3x9p2`. */
export const SHORTLINKS_PATH = '/l';
/** Sans `0 o 1 l i` : un code se recopie depuis une affiche sans hésiter. */
export const SHORTLINK_CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export const SHORTLINK_CODE_LENGTH = 6;
export const SHORTLINK_CODE_PATTERN = /^[a-hjkmnp-z2-9]{6}$/;
/**
 * L'alias d'un lien sur un domaine à soi : un segment, minuscules, chiffres et
 * tirets intérieurs, sans point (une route déclarée comme `/t.js` gagnerait).
 * Vide : la racine du domaine.
 */
export const SHORTLINK_SLUG_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)?$/;
export const SHORTLINK_SLUG_MAX = 64;
export const SHORTLINK_TITLE_MAX = 120;
export const SHORTLINK_URL_MAX = 2048;
export const SHORTLINK_PASSWORD_MIN = 4;
export const SHORTLINK_PASSWORD_MAX = 200;
export const SHORTLINK_UTM_MAX = 100;
export const SHORTLINK_MAX_VISITS_MAX = 100_000_000;
/** Ce qu'on garde d'un site référent : son nom d'hôte, borné. */
export const SHORTLINK_REFERRER_MAX = 255;
/** Les jours de la petite courbe de la liste. */
export const SHORTLINK_RECENT_DAYS = 30;

const urlSchema = z.url({ protocol: /^https?$/ }).max(SHORTLINK_URL_MAX);

/** Où mène le lien, selon l'appareil du visiteur ; `null` : la destination commune. */
export const shortlinkTargetsSchema = z.object({
    default: urlSchema,
    ios: urlSchema.nullable(),
    android: urlSchema.nullable()
});
export type ShortlinkTargets = z.infer<typeof shortlinkTargetsSchema>;

const utmValue = z.string().trim().max(SHORTLINK_UTM_MAX);

/** Les paramètres de campagne ajoutés à la destination ; vide : absent. */
export const shortlinkUtmSchema = z.object({
    source: utmValue,
    medium: utmValue,
    campaign: utmValue,
    term: utmValue,
    content: utmValue
});
export type ShortlinkUtm = z.infer<typeof shortlinkUtmSchema>;

export const EMPTY_UTM: ShortlinkUtm = { source: '', medium: '', campaign: '', term: '', content: '' };

/**
 * Ce que montre la liste : en service, coupé par son propriétaire, tenu en
 * pause par l'offre, retiré par l'administration, ou expiré (date passée ou
 * visites épuisées).
 */
export const shortlinkStatusSchema = z.enum(['active', 'disabled', 'planPaused', 'blocked', 'expired']);
export type ShortlinkStatus = z.infer<typeof shortlinkStatusSchema>;

export const shortlinkCheckStateSchema = z.enum(['unknown', 'ok', 'broken']);
export type ShortlinkCheckState = z.infer<typeof shortlinkCheckStateSchema>;

/** Le contrôle quotidien de la destination. */
export const shortlinkCheckSchema = z.object({
    enabled: z.boolean(),
    state: shortlinkCheckStateSchema,
    checkedAt: z.number().int().nullable(),
    /** Ce qui a échoué, en clair (« code 404 », « délai dépassé »). */
    error: z.string().nullable()
});
export type ShortlinkCheck = z.infer<typeof shortlinkCheckSchema>;

export const shortlinkSchema = z.object({
    id: z.number().int(),
    title: z.string(),
    code: z.string(),
    /** L'adresse sur DevEye : elle marche toujours, domaine ou non. */
    shortUrl: z.string(),
    domainId: z.number().int().nullable(),
    /** Le nom du domaine choisi, même tant qu'il n'est pas vérifié. */
    domainHost: z.string().nullable(),
    slug: z.string().nullable(),
    /** L'adresse sur le domaine choisi ; `null` sans domaine ou tant qu'il n'est pas vérifié. */
    domainUrl: z.string().nullable(),
    targets: shortlinkTargetsSchema,
    utm: shortlinkUtmSchema,
    hasPassword: z.boolean(),
    expiresAt: z.number().int().nullable(),
    maxVisits: z.number().int().nullable(),
    visits: z.number().int(),
    clicks: z.number().int(),
    /** Les visites des derniers jours, du plus ancien au plus récent : la petite courbe de la liste. */
    recent: z.array(z.number().int()),
    enabled: z.boolean(),
    status: shortlinkStatusSchema,
    /** Le motif d'un retrait par l'administration. */
    blockedReason: z.string().nullable(),
    check: shortlinkCheckSchema,
    /** Projeté depuis un autre espace. */
    foreign: z.boolean(),
    created: z.number().int(),
    updated: z.number().int()
});
export type Shortlink = z.infer<typeof shortlinkSchema>;

const quotaUsageSchema = z.object({ used: z.number().int(), limit: z.number().int().nullable() });

/** L'usage de l'offre du propriétaire de l'espace ; `null` : sans limite. */
export const shortlinkUsageSchema = z.object({
    links: quotaUsageSchema.nullable(),
    visits: quotaUsageSchema.nullable()
});
export type ShortlinkUsage = z.infer<typeof shortlinkUsageSchema>;

export const shortlinkRangeSchema = z.enum(['7d', '30d', '90d', '12m']);
export type ShortlinkRange = z.infer<typeof shortlinkRangeSchema>;

export const SHORTLINK_DIMENSIONS = ['referrer', 'country', 'device', 'browser', 'os', 'language'] as const;
export const shortlinkDimensionSchema = z.enum(SHORTLINK_DIMENSIONS);
export type ShortlinkDimension = z.infer<typeof shortlinkDimensionSchema>;

/** Un point du graphique : le début de son jour ou de sa semaine, en secondes UTC. */
export const shortlinkPointSchema = z.object({
    at: z.number().int(),
    clicks: z.number().int(),
    visits: z.number().int()
});
export type ShortlinkPoint = z.infer<typeof shortlinkPointSchema>;

/**
 * Une ligne d'un classement. `label` vide : inconnu (accès direct pour le
 * référent). Pays en code ISO (`FR`), langue en code court (`fr`), appareil
 * en `desktop`, `mobile` ou `tablet` : l'interface les nomme.
 */
export const shortlinkTopRowSchema = z.object({ label: z.string(), visits: z.number().int() });
export type ShortlinkTopRow = z.infer<typeof shortlinkTopRowSchema>;

export const shortlinkStatsSchema = z.object({
    range: shortlinkRangeSchema,
    bucket: z.enum(['day', 'week']),
    series: z.array(shortlinkPointSchema),
    totals: z.object({ clicks: z.number().int(), visits: z.number().int(), bots: z.number().int() }),
    /** La période de même durée juste avant. */
    previous: z.object({ clicks: z.number().int(), visits: z.number().int() }),
    top: z.object({
        referrer: z.array(shortlinkTopRowSchema),
        country: z.array(shortlinkTopRowSchema),
        device: z.array(shortlinkTopRowSchema),
        browser: z.array(shortlinkTopRowSchema),
        os: z.array(shortlinkTopRowSchema),
        language: z.array(shortlinkTopRowSchema)
    }),
    /** La mention que la base des pays exige à côté de leur classement. */
    attribution: z.object({ text: z.string(), url: z.string() })
});
export type ShortlinkStats = z.infer<typeof shortlinkStatsSchema>;

export const SHORTLINK_REPORT_REASONS = ['phishing', 'malware', 'spam', 'illegal', 'copyright', 'other'] as const;
export const shortlinkReportReasonSchema = z.enum(SHORTLINK_REPORT_REASONS);
export type ShortlinkReportReason = z.infer<typeof shortlinkReportReasonSchema>;

export const SHORTLINK_REPORT_REASON_LABELS: Readonly<Record<ShortlinkReportReason, string>> = {
    phishing: 'Hameçonnage ou arnaque',
    malware: 'Logiciel malveillant',
    spam: 'Spam',
    illegal: 'Contenu illicite',
    copyright: 'Atteinte au droit d’auteur ou à une marque',
    other: 'Autre motif'
};

export const shortlinkReportStatusSchema = z.enum(['open', 'dismissed', 'actioned']);
export type ShortlinkReportStatus = z.infer<typeof shortlinkReportStatusSchema>;

export const shortlinkReportSchema = z.object({
    id: z.number().int(),
    ref: z.string(),
    linkId: z.number().int().nullable(),
    linkTitle: z.string(),
    /** L'adresse signalée, telle que le visiteur l'a ouverte. */
    url: z.string(),
    /** Où menait le lien au moment du signalement. */
    target: z.string(),
    reason: shortlinkReportReasonSchema,
    message: z.string(),
    reporterName: z.string(),
    /** L'adresse et l'IP du signalant : `null` pour un modérateur, qui juge le contenu sans savoir d'où il vient. */
    reporterEmail: z.string().nullable(),
    ip: z.string().nullable(),
    status: shortlinkReportStatusSchema,
    /** La note de décision, lue par le propriétaire quand le lien est retiré. */
    decision: z.string(),
    /** Le lien est retiré par l'administration, quel que soit le signalement qui l'a voulu. */
    linkBlocked: z.boolean(),
    created: z.number().int(),
    closedAt: z.number().int().nullable()
});
export type ShortlinkReport = z.infer<typeof shortlinkReportSchema>;

/** L'alias saisi : en minuscules, sans barre ni espace autour. */
export function normaliseSlug(raw: string): string {
    return raw
        .trim()
        .toLowerCase()
        .replace(/^\/+|\/+$/g, '');
}
