import { z } from 'zod';

/**
 * Uptime monitoring: user-defined HTTP services the server pings on a schedule,
 * with long-term history, incidents and notifications.
 *
 * Storage split (see `Docs/SECURITY_MODEL.md`): everything the scheduler needs
 * to *plan* a check (cadence, timeout, enabled…) and everything a chart
 * aggregates (status, latency, timestamps) lives in clear columns; what
 * identifies the target (name, URL, expected keyword) and the error strings
 * are encrypted with the **open** tier, since the checker runs in the
 * background, with no session and no password.
 */

export const UPTIME_NAME_MAX_LENGTH = 80;
export const UPTIME_URL_MAX_LENGTH = 2048;
export const UPTIME_KEYWORD_MAX_LENGTH = 200;
/** Bounds of a service's cadence, in seconds (30 s → 24 h). */
export const UPTIME_INTERVAL_MIN = 30;
export const UPTIME_INTERVAL_MAX = 86400;
/** Bounds of a single request's timeout, in seconds. */
export const UPTIME_TIMEOUT_MIN = 1;
export const UPTIME_TIMEOUT_MAX = 120;
/** Consecutive failures required before a service is declared down. */
export const UPTIME_THRESHOLD_MAX = 10;

/**
 * What a service checks. `http`: the target answers (status, keyword).
 * `integrity`: the files a site serves have not changed since a reference the
 * user accepted (SHA-256 of every file, and the document's Content-Security-
 * Policy). A detector that must live on ANOTHER server than the one it watches.
 */
export const uptimeKindSchema = z.enum(['http', 'integrity']);
export type UptimeKind = z.infer<typeof uptimeKindSchema>;

/** An integrity check refetches a whole site: never more often than this, in seconds. */
export const UPTIME_INTEGRITY_INTERVAL_MIN = 300;
/** Extra files an integrity check verifies (site-relative paths). */
export const UPTIME_INTEGRITY_PATHS_MAX = 50;
export const UPTIME_INTEGRITY_PATH_MAX_LENGTH = 512;

/** HTTP verb used for the probe. `POST` sends no body : it only pokes the route. */
export const uptimeMethodSchema = z.enum(['GET', 'HEAD', 'POST']);
export type UptimeMethod = z.infer<typeof uptimeMethodSchema>;

/** `unknown` = never probed yet (just created, or paused before its first check). */
export const uptimeStatusSchema = z.enum(['up', 'down', 'unknown']);
export type UptimeStatus = z.infer<typeof uptimeStatusSchema>;

/**
 * How long a service keeps its **raw** per-ping rows. The daily rollup is never
 * pruned, so uptime ratios stay readable years back whatever this is set to.
 * `null` = keep every ping forever (the default).
 */
export const uptimeRetentionSchema = z.number().int().positive().max(3650).nullable();

/** Window a chart or a ratio is computed over. */
export const uptimeRangeSchema = z.enum(['24h', '7d', '30d', '90d', '1y', 'all']);
export type UptimeRange = z.infer<typeof uptimeRangeSchema>;

/**
 * Bucket size the server picked for a history query: one point per ping (`raw`),
 * per hour, or per day. Chosen from the range so a year-long chart never carries
 * hundreds of thousands of points.
 */
export const uptimeResolutionSchema = z.enum(['raw', 'hour', 'day']);
export type UptimeResolution = z.infer<typeof uptimeResolutionSchema>;

/** One monitored service: its configuration, its live state and its ratios. */
/**
 * What an integrity service compares against, as the screen sees it: never the
 * fingerprints themselves. `null` until the first successful capture.
 */
export const uptimeBaselineSchema = z.object({
    capturedAt: z.number().int().nonnegative(),
    fileCount: z.number().int().nonnegative(),
    /** The document carried a Content-Security-Policy, watched since. */
    csp: z.boolean(),
    /** `manifest`: the site names its files (`/.well-known/deveye-build.json`); `page`: found in the page. */
    source: z.enum(['manifest', 'page'])
});
export type UptimeBaseline = z.infer<typeof uptimeBaselineSchema>;

export const uptimeServiceSchema = z.object({
    id: z.number().int().positive(),
    kind: uptimeKindSchema,
    name: z.string(),
    url: z.string(),
    /** Integrity only: extra site-relative files to verify (`/t.js`). */
    paths: z.array(z.string()),
    baseline: uptimeBaselineSchema.nullable(),
    method: uptimeMethodSchema,
    /** Exact status code required, or `null` to accept any 2xx/3xx. */
    expectedStatus: z.number().int().min(100).max(599).nullable(),
    /** Substring the response body must contain, or `null` to skip the check. */
    keyword: z.string().nullable(),
    intervalSeconds: z.number().int().positive(),
    timeoutSeconds: z.number().int().positive(),
    failureThreshold: z.number().int().positive(),
    retentionDays: uptimeRetentionSchema,
    /** Paused services keep their history but are never probed. */
    enabled: z.boolean(),
    /**
     * Au-delà de la limite de l'offre de son propriétaire : ni sondé ni testé
     * à la demande, sans que `enabled`, le choix de l'utilisateur, ne bouge.
     */
    planPaused: z.boolean(),
    /** Rank in the list; only the user's drag & drop changes it. */
    sortOrder: z.number().int().nonnegative(),
    /**
     * Projeté depuis un autre espace : il se lit et se modifie normalement,
     * mais l'écran le signale, parce que le supprimer d'ici toucherait la
     * donnée d'ailleurs.
     */
    foreign: z.boolean(),

    status: uptimeStatusSchema,
    lastCheckedAt: z.number().int().nonnegative().nullable(),
    lastResponseMs: z.number().int().nonnegative().nullable(),
    lastHttpStatus: z.number().int().nullable(),
    /** Why the last probe failed, or `null` when it succeeded. */
    lastError: z.string().nullable(),
    /** Start of the ongoing outage, or `null` while the service is healthy. */
    downSince: z.number().int().nonnegative().nullable(),

    /** Share of successful pings over the window (0 → 1), `null` without data. */
    ratio24h: z.number().min(0).max(1).nullable(),
    ratio7d: z.number().min(0).max(1).nullable(),
    ratio30d: z.number().min(0).max(1).nullable(),
    /** Mean response time over the last 24 h, in ms. */
    avgMs24h: z.number().int().nonnegative().nullable(),

    created: z.number().int().nonnegative()
});
export type UptimeService = z.infer<typeof uptimeServiceSchema>;

/** A single recorded probe : the "journal des pings". */
export const uptimeCheckSchema = z.object({
    at: z.number().int().nonnegative(),
    up: z.boolean(),
    httpStatus: z.number().int().nullable(),
    responseMs: z.number().int().nonnegative().nullable(),
    error: z.string().nullable()
});
export type UptimeCheck = z.infer<typeof uptimeCheckSchema>;

/**
 * Aggregates over a filtered slice of a service's raw pings : what the measures
 * browser shows above its list, computed over the **whole** selection rather
 * than the loaded page.
 */
export const uptimeCheckStatsSchema = z.object({
    count: z.number().int().nonnegative(),
    failures: z.number().int().nonnegative(),
    avgMs: z.number().int().nonnegative().nullable(),
    minMs: z.number().int().nonnegative().nullable(),
    maxMs: z.number().int().nonnegative().nullable(),
    /** Bounds of the selection; `null` when it holds nothing. */
    firstAt: z.number().int().nonnegative().nullable(),
    lastAt: z.number().int().nonnegative().nullable()
});
export type UptimeCheckStats = z.infer<typeof uptimeCheckStatsSchema>;

/**
 * One chart point. A `raw` point is a single ping (`checks === 1`); an `hour` or
 * `day` point aggregates every ping of its bucket, which is what keeps a
 * multi-year chart cheap.
 */
export const uptimePointSchema = z.object({
    /** Bucket start, epoch seconds. */
    at: z.number().int().nonnegative(),
    checks: z.number().int().positive(),
    upChecks: z.number().int().nonnegative(),
    avgMs: z.number().int().nonnegative().nullable(),
    minMs: z.number().int().nonnegative().nullable(),
    maxMs: z.number().int().nonnegative().nullable()
});
export type UptimePoint = z.infer<typeof uptimePointSchema>;

/**
 * A continuous outage. Opened when a service crosses its failure threshold,
 * closed on the first successful probe : so the list reads as a plain incident
 * history, and it survives raw-history pruning.
 */
export const uptimeIncidentSchema = z.object({
    id: z.number().int().positive(),
    startedAt: z.number().int().nonnegative(),
    /** `null` while the outage is still ongoing. */
    endedAt: z.number().int().nonnegative().nullable(),
    httpStatus: z.number().int().nullable(),
    error: z.string().nullable()
});
export type UptimeIncident = z.infer<typeof uptimeIncidentSchema>;

export const UPTIME_PAGE_TITLE_MAX_LENGTH = 80;
export const UPTIME_PAGE_DESCRIPTION_MAX_LENGTH = 500;
/** Au-delà, une page de statut cesse de se lire d'un coup d'œil. */
export const UPTIME_PAGE_SERVICES_MAX = 30;
/** Les jours que couvrent les barres d'une page de statut. */
export const UPTIME_PAGE_DAYS = 90;

/** `auto` suit le thème du visiteur. */
export const uptimePageThemeSchema = z.enum(['auto', 'light', 'dark']);
export type UptimePageTheme = z.infer<typeof uptimePageThemeSchema>;

/** Un service sur une page, et le nom sous lequel le public le voit. */
export const uptimePageServiceSchema = z.object({
    id: z.number().int().positive(),
    /** `null` : le nom du service. */
    label: z.string().trim().min(1).max(UPTIME_NAME_MAX_LENGTH).nullable()
});
export type UptimePageService = z.infer<typeof uptimePageServiceSchema>;

/**
 * Une page de statut publique : quelques services de l'espace, lisibles sans
 * compte, sous l'adresse de DevEye ou à la racine d'un domaine de l'espace.
 */
export const uptimePageSchema = z.object({
    id: z.number().int().positive(),
    title: z.string(),
    description: z.string(),
    /** L'adresse à partager : la racine du domaine choisi s'il est vérifié, sinon celle de DevEye. */
    url: z.string(),
    domainId: z.number().int().positive().nullable(),
    theme: uptimePageThemeSchema,
    /** Montrer la nature d'une panne (code HTTP, délai…), jamais son message brut. */
    showErrors: z.boolean(),
    /** Montrer le temps de réponse des dernières 24 h. */
    showLatency: z.boolean(),
    /** Une page désactivée répond « introuvable » : son lien ne dit plus rien. */
    enabled: z.boolean(),
    /** Au-delà de la limite de l'offre : elle répond « introuvable », sans que `enabled` ne bouge. */
    planPaused: z.boolean(),
    services: z.array(uptimePageServiceSchema),
    created: z.number().int().nonnegative()
});
export type UptimePage = z.infer<typeof uptimePageSchema>;

/** Database row shapes (server-only). Mirror the columns exactly. */
export interface UptimeServiceRow {
    id: number;
    user_id: number;
    workspace_id: number;
    /** Encrypted `{ name, url, keyword, paths }` (open tier). */
    content: string;
    kind: UptimeKind;
    method: UptimeMethod;
    expected_status: number | null;
    interval_seconds: number;
    timeout_seconds: number;
    failure_threshold: number;
    retention_days: number | null;
    enabled: number;
    sort_order: number;
    status: UptimeStatus;
    consecutive_failures: number;
    last_checked_at: number | null;
    last_response_ms: number | null;
    last_http_status: number | null;
    /** Encrypted error string (open tier), or null after a success. */
    last_error: string | null;
    /** Integrity only: encrypted reference (open tier), null until learned. */
    baseline_enc: string | null;
    created: number;
}

export interface UptimeCheckRow {
    id: number;
    service_id: number;
    checked_at: number;
    up: number;
    http_status: number | null;
    response_ms: number | null;
    /** Encrypted error string (open tier). */
    error: string | null;
}

export interface UptimeDayRow {
    service_id: number;
    day: number;
    checks: number;
    up_checks: number;
    total_ms: number;
    ms_samples: number;
    min_ms: number | null;
    max_ms: number | null;
}

export interface UptimeIncidentRow {
    id: number;
    service_id: number;
    started_at: number;
    ended_at: number | null;
    http_status: number | null;
    /** Encrypted error string (open tier). */
    error: string | null;
    notified: number;
}

export interface UptimePageRow {
    id: number;
    workspace_id: number;
    public_ref: string;
    /** Encrypted `{ title, description }` (open tier). */
    content: string;
    domain_id: number | null;
    theme: UptimePageTheme;
    show_errors: number;
    show_latency: number;
    enabled: number;
    created: number;
}

export interface UptimePageServiceRow {
    page_id: number;
    service_id: number;
    sort_order: number;
    /** Encrypted public name (open tier), or null for the service's own. */
    label: string | null;
}
