import { z } from 'zod';
import {
    UPTIME_INTERVAL_MAX,
    UPTIME_INTERVAL_MIN,
    UPTIME_KEYWORD_MAX_LENGTH,
    UPTIME_NAME_MAX_LENGTH,
    UPTIME_THRESHOLD_MAX,
    UPTIME_TIMEOUT_MAX,
    UPTIME_TIMEOUT_MIN,
    UPTIME_URL_MAX_LENGTH,
    uptimeCheckSchema,
    uptimeCheckStatsSchema,
    uptimeIncidentSchema,
    uptimeMethodSchema,
    uptimePointSchema,
    uptimeRangeSchema,
    uptimeResolutionSchema,
    uptimeRetentionSchema,
    uptimeServiceSchema
} from './domain';

const serviceId = z.number().int().positive();

/** Everything the user may set on a service. */
const uptimeDraftSchema = z.object({
    name: z.string().min(1).max(UPTIME_NAME_MAX_LENGTH),
    url: z.url({ protocol: /^https?$/ }).max(UPTIME_URL_MAX_LENGTH),
    method: uptimeMethodSchema,
    expectedStatus: z.number().int().min(100).max(599).nullable(),
    keyword: z.string().max(UPTIME_KEYWORD_MAX_LENGTH).nullable(),
    intervalSeconds: z.number().int().min(UPTIME_INTERVAL_MIN).max(UPTIME_INTERVAL_MAX),
    timeoutSeconds: z.number().int().min(UPTIME_TIMEOUT_MIN).max(UPTIME_TIMEOUT_MAX),
    failureThreshold: z.number().int().min(1).max(UPTIME_THRESHOLD_MAX),
    retentionDays: uptimeRetentionSchema,
    enabled: z.boolean()
});

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
    input: z.object({ service: uptimeDraftSchema }),
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

export const uptimeCommands = [
    uptimeList,
    uptimeCount,
    uptimeAdd,
    uptimeUpdate,
    uptimeSetEnabled,
    uptimeRemove,
    uptimeReorder,
    uptimeCheckNow,
    uptimeHistory,
    uptimeChecks,
    uptimeCheckStats,
    uptimeIncidents
] as const;
