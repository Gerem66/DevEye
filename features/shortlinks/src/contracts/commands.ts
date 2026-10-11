import { z } from 'zod';

import {
    SHORTLINK_MAX_VISITS_MAX,
    SHORTLINK_PASSWORD_MAX,
    SHORTLINK_PASSWORD_MIN,
    SHORTLINK_SLUG_MAX,
    SHORTLINK_TITLE_MAX,
    SHORTLINK_URL_MAX,
    shortlinkRangeSchema,
    shortlinkReportSchema,
    shortlinkSchema,
    shortlinkStatsSchema,
    shortlinkTargetsSchema,
    shortlinkUsageSchema,
    shortlinkUtmSchema
} from './domain';

const id = z.number().int().positive();
const title = z.string().trim().max(SHORTLINK_TITLE_MAX);
/** `null` : l'adresse de DevEye seule. */
const domainId = id.nullable();
/** `null` sans domaine ; vide : la racine du domaine. */
const slug = z.string().max(SHORTLINK_SLUG_MAX).nullable();

/** Ce que lit la carte de l'accueil. */
export const shortlinksCount = {
    command: 'shortlinks.count' as const,
    input: z.object({}),
    output: z.object({
        total: z.number().int().nonnegative(),
        active: z.number().int().nonnegative(),
        visitsToday: z.number().int().nonnegative()
    })
};

/** Les liens visibles depuis l'espace, projetés compris, et l'usage de l'offre. */
export const shortlinksList = {
    command: 'shortlinks.list' as const,
    input: z.object({}),
    output: z.object({ links: z.array(shortlinkSchema), usage: shortlinkUsageSchema })
};

export const shortlinksGet = {
    command: 'shortlinks.get' as const,
    input: z.object({ id }),
    output: z.object({ link: shortlinkSchema })
};

/** Créer : une destination, un titre facultatif, et l'adresse. Le reste se règle ensuite. */
export const shortlinksAdd = {
    command: 'shortlinks.add' as const,
    input: z.object({
        link: z.object({
            title,
            target: z.url({ protocol: /^https?$/ }).max(SHORTLINK_URL_MAX),
            domainId,
            slug
        })
    }),
    output: z.object({ link: shortlinkSchema })
};

/** L'onglet Général : titre, destinations, adresse, contrôle de la destination. */
export const shortlinksUpdate = {
    command: 'shortlinks.update' as const,
    input: z.object({
        id,
        link: z.object({
            title,
            targets: shortlinkTargetsSchema,
            domainId,
            slug,
            checkTarget: z.boolean()
        })
    }),
    output: z.object({ link: shortlinkSchema })
};

const passwordChange = z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('keep') }),
    z.object({ mode: z.literal('set'), value: z.string().min(SHORTLINK_PASSWORD_MIN).max(SHORTLINK_PASSWORD_MAX) }),
    z.object({ mode: z.literal('clear') })
]);

/** L'onglet Accès : mot de passe, date de fin, nombre de visites avant expiration. */
export const shortlinksUpdateAccess = {
    command: 'shortlinks.updateAccess' as const,
    input: z.object({
        id,
        access: z.object({
            password: passwordChange,
            expiresAt: z.number().int().positive().nullable(),
            maxVisits: z.number().int().min(1).max(SHORTLINK_MAX_VISITS_MAX).nullable()
        })
    }),
    output: z.object({ link: shortlinkSchema })
};

/** L'onglet Campagne : les paramètres ajoutés à la destination. */
export const shortlinksUpdateCampaign = {
    command: 'shortlinks.updateCampaign' as const,
    input: z.object({ id, utm: shortlinkUtmSchema }),
    output: z.object({ link: shortlinkSchema })
};

/** Couper ou rétablir un lien sans rien perdre de ses réglages ni de ses chiffres. */
export const shortlinksSetEnabled = {
    command: 'shortlinks.setEnabled' as const,
    input: z.object({ id, enabled: z.boolean() }),
    output: z.object({ link: shortlinkSchema })
};

/** Supprimer un lien et ses statistiques : son adresse ne répond plus. */
export const shortlinksRemove = {
    command: 'shortlinks.remove' as const,
    input: z.object({ id }),
    output: z.object({ id })
};

/** Les chiffres d'un lien, ou de tous les liens visibles quand `id` est nul. */
export const shortlinksStats = {
    command: 'shortlinks.stats' as const,
    input: z.object({ id: id.nullable(), range: shortlinkRangeSchema }),
    output: z.object({ stats: shortlinkStatsSchema })
};

/** Le QR code d'une adresse du lien, en SVG : celle de DevEye, ou celle du domaine. */
export const shortlinksQr = {
    command: 'shortlinks.qr' as const,
    input: z.object({ id, address: z.enum(['short', 'domain']) }),
    output: z.object({ url: z.string(), svg: z.string() })
};

/** Vérifier la destination tout de suite, sans attendre le contrôle du jour. */
export const shortlinksCheckNow = {
    command: 'shortlinks.checkNow' as const,
    input: z.object({ id }),
    output: z.object({ link: shortlinkSchema })
};

export const shortlinksReports = {
    command: 'shortlinks.reports' as const,
    input: z.object({ status: z.enum(['open', 'closed']) }),
    output: z.object({ reports: z.array(shortlinkReportSchema), open: z.number().int() })
};

/**
 * La décision sur un signalement. `block` retire le lien pour tout le monde et
 * prévient son auteur, avec la note ; `dismiss` classe sans suite.
 */
export const shortlinksReportDecide = {
    command: 'shortlinks.reportDecide' as const,
    input: z.object({
        reportId: id,
        decision: z.enum(['block', 'dismiss']),
        note: z.string().trim().max(1_000)
    }),
    output: z.object({ report: shortlinkReportSchema })
};

/** Remet en service un lien retiré par l'administration. */
export const shortlinksRestore = {
    command: 'shortlinks.restore' as const,
    input: z.object({ reportId: id }),
    output: z.object({ report: shortlinkReportSchema })
};

export const shortlinksCommands = [
    shortlinksCount,
    shortlinksList,
    shortlinksGet,
    shortlinksAdd,
    shortlinksUpdate,
    shortlinksUpdateAccess,
    shortlinksUpdateCampaign,
    shortlinksSetEnabled,
    shortlinksRemove,
    shortlinksStats,
    shortlinksQr,
    shortlinksCheckNow,
    shortlinksReports,
    shortlinksReportDecide,
    shortlinksRestore
] as const;
