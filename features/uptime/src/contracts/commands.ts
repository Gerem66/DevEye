import { z } from 'zod';
import {
    UPTIME_INTEGRITY_INTERVAL_MIN,
    UPTIME_INTEGRITY_PATH_MAX_LENGTH,
    UPTIME_INTEGRITY_PATHS_MAX,
    UPTIME_INTERVAL_MAX,
    UPTIME_INTERVAL_MIN,
    UPTIME_KEYWORD_MAX_LENGTH,
    UPTIME_NAME_MAX_LENGTH,
    UPTIME_PAGE_DESCRIPTION_MAX_LENGTH,
    UPTIME_PAGE_SERVICES_MAX,
    UPTIME_PAGE_TITLE_MAX_LENGTH,
    UPTIME_THRESHOLD_MAX,
    UPTIME_TIMEOUT_MAX,
    UPTIME_TIMEOUT_MIN,
    UPTIME_URL_MAX_LENGTH,
    uptimeCheckSchema,
    uptimeCheckStatsSchema,
    uptimeIncidentSchema,
    uptimeKindSchema,
    uptimeMethodSchema,
    uptimePageSchema,
    uptimePageServiceSchema,
    uptimePageThemeSchema,
    uptimePointSchema,
    uptimeRangeSchema,
    uptimeResolutionSchema,
    uptimeRetentionSchema,
    uptimeServiceSchema
} from './domain';

const serviceId = z.number().int().positive();

/** A site-relative path an integrity check adds to what it verifies: `/t.js`. */
const integrityPathSchema = z
    .string()
    .max(UPTIME_INTEGRITY_PATH_MAX_LENGTH)
    .regex(/^\/[^\s]*$/)
    .refine((p) => !/(^|\/)\.\.(\/|$)/.test(p), 'Chemin invalide');

/** Everything the user may set on a service. `kind` is fixed at creation. */
const uptimeDraftFields = z.object({
    kind: uptimeKindSchema,
    name: z.string().min(1).max(UPTIME_NAME_MAX_LENGTH),
    url: z.url({ protocol: /^https?$/ }).max(UPTIME_URL_MAX_LENGTH),
    paths: z.array(integrityPathSchema).max(UPTIME_INTEGRITY_PATHS_MAX),
    method: uptimeMethodSchema,
    expectedStatus: z.number().int().min(100).max(599).nullable(),
    keyword: z.string().max(UPTIME_KEYWORD_MAX_LENGTH).nullable(),
    intervalSeconds: z.number().int().min(UPTIME_INTERVAL_MIN).max(UPTIME_INTERVAL_MAX),
    timeoutSeconds: z.number().int().min(UPTIME_TIMEOUT_MIN).max(UPTIME_TIMEOUT_MAX),
    failureThreshold: z.number().int().min(1).max(UPTIME_THRESHOLD_MAX),
    retentionDays: uptimeRetentionSchema,
    enabled: z.boolean()
});

const integrityCadence = {
    message: `Un contrôle d’intégrité relit tout un site : au plus toutes les ${UPTIME_INTEGRITY_INTERVAL_MIN / 60} minutes.`,
    path: ['intervalSeconds']
};

const uptimeDraftSchema = uptimeDraftFields.refine(
    (d) => d.kind !== 'integrity' || d.intervalSeconds >= UPTIME_INTEGRITY_INTERVAL_MIN,
    integrityCadence
);

/** A new service may leave its cadence out: the server then applies the owner plan's default. */
const uptimeNewDraftSchema = uptimeDraftFields
    .extend({ intervalSeconds: uptimeDraftFields.shape.intervalSeconds.optional() })
    .refine(
        (d) =>
            d.kind !== 'integrity' ||
            d.intervalSeconds === undefined ||
            d.intervalSeconds >= UPTIME_INTEGRITY_INTERVAL_MIN,
        integrityCadence
    );

/**
 * List the workspace's services in the user's own order, each carrying its live
 * state and its 24 h / 7 d / 30 d ratios. Never gated: uptime data lives in the
 * open tier, so the feature opens with no password prompt.
 */
export const uptimeList = {
    command: 'uptime.list' as const,
    input: z.object({}),
    output: z.object({ services: z.array(uptimeServiceSchema) })
};

/**
 * "N services up out of M" : the only thing the home card and the navbar widget
 * need. Pure clear metadata, so it costs one indexed count. Paused services are
 * excluded entirely, and `up + down` may be **below** `total`: one awaiting its
 * first probe is neither, and must not be reported as a failure.
 */
export const uptimeCount = {
    command: 'uptime.count' as const,
    input: z.object({}),
    output: z.object({
        total: z.number().int().nonnegative(),
        up: z.number().int().nonnegative(),
        down: z.number().int().nonnegative()
    })
};

export const uptimeAdd = {
    command: 'uptime.add' as const,
    input: z.object({ service: uptimeNewDraftSchema }),
    output: z.object({ service: uptimeServiceSchema })
};

/** Replace a service's whole configuration. History and incidents are kept. */
export const uptimeUpdate = {
    command: 'uptime.update' as const,
    input: z.object({ id: serviceId, service: uptimeDraftSchema }),
    output: z.object({ service: uptimeServiceSchema })
};

/**
 * Pause or resume probing without touching the rest of the configuration : a
 * paused service keeps its history and simply stops being scheduled.
 */
export const uptimeSetEnabled = {
    command: 'uptime.setEnabled' as const,
    input: z.object({ id: serviceId, enabled: z.boolean() }),
    output: z.object({ service: uptimeServiceSchema })
};

/** Destroy a service **and its whole history** : there is no archive here. */
export const uptimeRemove = {
    command: 'uptime.remove' as const,
    input: z.object({ id: serviceId }),
    output: z.object({ id: serviceId })
};

/**
 * Lay out the workspace's services: `ids` is the **complete** list in its final
 * order. Nothing else positions a service (new ones are appended). Touches no
 * probe state.
 */
export const uptimeReorder = {
    command: 'uptime.reorder' as const,
    input: z.object({ ids: z.array(serviceId).min(1) }),
    output: z.object({ ids: z.array(serviceId) })
};

/** Probe a service right now instead of waiting for its next tick. */
export const uptimeCheckNow = {
    command: 'uptime.checkNow' as const,
    input: z.object({ id: serviceId }),
    output: z.object({ service: uptimeServiceSchema })
};

/**
 * Chart series over a window. The server picks the bucket size from the range
 * (`raw` up to 24 h, hourly up to 30 d, daily beyond) and reads the long ranges
 * from the daily rollup, which is never pruned.
 */
export const uptimeHistory = {
    command: 'uptime.history' as const,
    input: z.object({ id: serviceId, range: uptimeRangeSchema }),
    output: z.object({
        resolution: uptimeResolutionSchema,
        points: z.array(uptimePointSchema)
    })
};

/**
 * Which pings a journal query is about. Shared by {@link uptimeChecks} and
 * {@link uptimeCheckStats} so a page and its aggregates always describe the
 * exact same selection.
 */
const checkFilterSchema = z.object({
    /** Keep only probes at or after this epoch second; `null` = the whole history. */
    since: z.number().int().nonnegative().nullable(),
    /** Restrict to failed probes. */
    failuresOnly: z.boolean()
});

/**
 * Raw ping journal, most recent first. `before` pages backwards through time
 * (exclusive upper bound, epoch seconds).
 */
export const uptimeChecks = {
    command: 'uptime.checks' as const,
    input: z.object({
        id: serviceId,
        limit: z.number().int().min(1).max(200),
        before: z.number().int().nonnegative().optional(),
        filter: checkFilterSchema
    }),
    output: z.object({ checks: z.array(uptimeCheckSchema) })
};

/**
 * Aggregates over the same selection {@link uptimeChecks} pages through. Kept a
 * separate command on purpose: it scans the whole filtered range, so the short
 * "last few measures" list on the detail view never pays for it.
 */
export const uptimeCheckStats = {
    command: 'uptime.checkStats' as const,
    input: z.object({ id: serviceId, filter: checkFilterSchema }),
    output: z.object({ stats: uptimeCheckStatsSchema })
};

/** Outage history, most recent first; the ongoing one (if any) comes back too. */
export const uptimeIncidents = {
    command: 'uptime.incidents' as const,
    input: z.object({ id: serviceId, limit: z.number().int().min(1).max(100) }),
    output: z.object({ incidents: z.array(uptimeIncidentSchema) })
};

const pageId = z.number().int().positive();

/** Tout ce qui se règle sur une page de statut. */
const uptimePageDraftSchema = z.object({
    title: z.string().trim().min(1).max(UPTIME_PAGE_TITLE_MAX_LENGTH),
    description: z.string().trim().max(UPTIME_PAGE_DESCRIPTION_MAX_LENGTH),
    /** Dans l'ordre où la page les montre. */
    services: z
        .array(uptimePageServiceSchema)
        .min(1)
        .max(UPTIME_PAGE_SERVICES_MAX)
        .refine((list) => new Set(list.map((s) => s.id)).size === list.length, {
            message: 'Un service ne figure qu’une fois sur une page.'
        }),
    /** Un domaine vérifié de l'espace, qui sert la page à sa racine ; `null` : l'adresse de DevEye seule. */
    domainId: z.number().int().positive().nullable(),
    theme: uptimePageThemeSchema,
    showErrors: z.boolean(),
    showLatency: z.boolean(),
    enabled: z.boolean()
});
export type UptimePageDraft = z.infer<typeof uptimePageDraftSchema>;

/**
 * Les pages de statut de l'espace. `limit` est ce que l'offre du propriétaire
 * permet (`null` : sans limite), pour que l'écran dise d'avance qu'il n'en
 * permet aucune.
 */
export const uptimePageList = {
    command: 'uptime.pageList' as const,
    input: z.object({}),
    output: z.object({
        pages: z.array(uptimePageSchema),
        limit: z.number().int().nonnegative().nullable()
    })
};

export const uptimePageAdd = {
    command: 'uptime.pageAdd' as const,
    input: z.object({ page: uptimePageDraftSchema }),
    output: z.object({ page: uptimePageSchema })
};

/** Remplace le réglage entier de la page ; son lien ne change pas. */
export const uptimePageUpdate = {
    command: 'uptime.pageUpdate' as const,
    input: z.object({ id: pageId, page: uptimePageDraftSchema }),
    output: z.object({ page: uptimePageSchema })
};

/** Le lien cesse aussitôt de répondre, et les services, eux, ne bougent pas. */
export const uptimePageRemove = {
    command: 'uptime.pageRemove' as const,
    input: z.object({ id: pageId }),
    output: z.object({ id: pageId })
};

/**
 * Integrity: take what the site serves NOW as the reference (after a deployment
 * one made, say). Closes the incident the drift had opened. The files are
 * refetched first: what is accepted is what a visitor gets at that moment.
 */
export const uptimeAcceptBaseline = {
    command: 'uptime.acceptBaseline' as const,
    input: z.object({ id: serviceId }),
    output: z.object({ service: uptimeServiceSchema })
};

export const uptimeCommands = [
    uptimeList,
    uptimeCount,
    uptimeAdd,
    uptimeUpdate,
    uptimeSetEnabled,
    uptimeRemove,
    uptimeReorder,
    uptimeCheckNow,
    uptimeAcceptBaseline,
    uptimeHistory,
    uptimeChecks,
    uptimeCheckStats,
    uptimeIncidents,
    uptimePageList,
    uptimePageAdd,
    uptimePageUpdate,
    uptimePageRemove
] as const;
