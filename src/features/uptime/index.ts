import {
    uptimeAdd,
    uptimeCheckNow,
    uptimeCheckStats,
    uptimeChecks,
    uptimeCount,
    uptimeGetSettings,
    uptimeHistory,
    uptimeIncidents,
    uptimeList,
    uptimeRemove,
    uptimeReorder,
    uptimeSetEnabled,
    uptimeSetSettings,
    uptimeTestNotification,
    uptimeUpdate
} from 'deveye-types';
import type { UptimePoint, UptimeRange, UptimeResolution, UptimeService, UptimeServiceRow } from 'deveye-types';

import type { UptimeWindowStat } from '@/db/repos/uptime';
import { getNotificationSettings, setNotificationSettings } from '../_notifications';
import { defineFeature, FeatureError, type FeatureContext, type FeatureDefinition } from '../_define';
import { decryptError, encryptService, toIncident, toService, EMPTY_STATS, type ServiceStats } from './_shared';

const DAY = 86400;

/** Load one service of the active workspace, or throw `not_found`. */
async function loadService(ctx: FeatureContext, id: number): Promise<UptimeServiceRow> {
    const row = await ctx.db.uptimeServices.findById(id, ctx.workspaceId);
    if (!row) throw new FeatureError('not_found', 'Uptime service not found');
    return row;
}

/** The scheduler, or a typed error when the server runs without it (tests). */
function monitor(ctx: FeatureContext) {
    if (!ctx.uptime) throw new FeatureError('internal', 'Uptime monitor unavailable');
    return ctx.uptime;
}

function ratio(stat: UptimeWindowStat | undefined): number | null {
    return stat && stat.checks > 0 ? stat.upChecks / stat.checks : null;
}

/**
 * Ratios for every one of the caller's services, in three grouped queries (one
 * per window) rather than three per service.
 *
 * Only the 24 h figure reads the raw pings; the multi-day ones come from the
 * daily rollup — a handful of rows per service instead of tens of thousands, and
 * still complete for a service whose raw history has been pruned. They are
 * therefore whole UTC days rather than a rolling window, which is also how
 * uptime is conventionally reported.
 */
async function loadStats(ctx: FeatureContext, now: number): Promise<Map<number, ServiceStats>> {
    const today = Math.floor(now / DAY) * DAY;
    const [day, week, month] = await Promise.all([
        ctx.db.uptimeHistory.windowStats(ctx.workspaceId, now - DAY),
        ctx.db.uptimeHistory.dailyWindowStats(ctx.workspaceId, today - 6 * DAY),
        ctx.db.uptimeHistory.dailyWindowStats(ctx.workspaceId, today - 29 * DAY)
    ]);
    const index = (rows: UptimeWindowStat[]) => new Map(rows.map((r) => [r.serviceId, r]));
    const [byDay, byWeek, byMonth] = [index(day), index(week), index(month)];

    const ids = new Set([...byDay.keys(), ...byWeek.keys(), ...byMonth.keys()]);
    const out = new Map<number, ServiceStats>();
    for (const id of ids) {
        out.set(id, {
            ratio24h: ratio(byDay.get(id)),
            ratio7d: ratio(byWeek.get(id)),
            ratio30d: ratio(byMonth.get(id)),
            avgMs24h: byDay.get(id)?.avgMs ?? null
        });
    }
    return out;
}

/** Build the DTOs for a set of rows, folding in stats and ongoing outages. */
async function toServices(ctx: FeatureContext, rows: UptimeServiceRow[]): Promise<UptimeService[]> {
    const now = Math.floor(Date.now() / 1000);
    const [stats, open] = await Promise.all([
        loadStats(ctx, now),
        ctx.db.uptimeHistory.listOpenIncidents(ctx.workspaceId)
    ]);
    const downSince = new Map(open.map((i) => [i.service_id, i.started_at]));
    return Promise.all(
        rows.map((row) =>
            toService(ctx.secure.open, row, stats.get(row.id) ?? EMPTY_STATS, downSince.get(row.id) ?? null)
        )
    );
}

/** Single-service variant, used by every command that returns one service. */
async function toOneService(ctx: FeatureContext, row: UptimeServiceRow): Promise<UptimeService> {
    const [service] = await toServices(ctx, [row]);
    return service;
}

export const uptimeListFeature: FeatureDefinition<
    typeof uptimeList.command,
    typeof uptimeList.input,
    typeof uptimeList.output
> = defineFeature({
    ...uptimeList,
    handler: async (ctx) => {
        const rows = await ctx.db.uptimeServices.listByWorkspace(ctx.workspaceId);
        return { services: await toServices(ctx, rows) };
    }
});

export const uptimeCountFeature: FeatureDefinition<
    typeof uptimeCount.command,
    typeof uptimeCount.input,
    typeof uptimeCount.output
> = defineFeature({
    ...uptimeCount,
    handler: async (ctx) => ctx.db.uptimeServices.countByWorkspace(ctx.workspaceId)
});

export const uptimeAddFeature: FeatureDefinition<
    typeof uptimeAdd.command,
    typeof uptimeAdd.input,
    typeof uptimeAdd.output
> = defineFeature({
    ...uptimeAdd,
    mutates: true,
    handler: async (ctx, input) => {
        const draft = input.service;
        const row = await ctx.db.uptimeServices.create({
            userId: ctx.userId,
            workspaceId: ctx.workspaceId,
            content: await encryptService(ctx.secure.open, {
                name: draft.name,
                url: draft.url,
                keyword: draft.keyword
            }),
            method: draft.method,
            expectedStatus: draft.expectedStatus,
            intervalSeconds: draft.intervalSeconds,
            timeoutSeconds: draft.timeoutSeconds,
            failureThreshold: draft.failureThreshold,
            retentionDays: draft.retentionDays,
            notify: draft.notify,
            enabled: draft.enabled
        });
        ctx.audit({
            action: 'uptime.add',
            description: `Service surveillé ajouté : « ${draft.name} »`,
            metadata: { serviceId: row.id }
        });
        // Probe straight away so the card doesn't sit on "jamais testé" until
        // the first tick — the user just told us the URL, show them if it works.
        // A service created already paused is left alone, as the user asked.
        if (row.enabled === 1) await monitor(ctx).runOne(row);
        return { service: await toOneService(ctx, await loadService(ctx, row.id)) };
    }
});

export const uptimeUpdateFeature: FeatureDefinition<
    typeof uptimeUpdate.command,
    typeof uptimeUpdate.input,
    typeof uptimeUpdate.output
> = defineFeature({
    ...uptimeUpdate,
    mutates: true,
    handler: async (ctx, input) => {
        await loadService(ctx, input.id);
        const draft = input.service;
        const row = await ctx.db.uptimeServices.update(input.id, ctx.workspaceId, {
            content: await encryptService(ctx.secure.open, {
                name: draft.name,
                url: draft.url,
                keyword: draft.keyword
            }),
            method: draft.method,
            expectedStatus: draft.expectedStatus,
            intervalSeconds: draft.intervalSeconds,
            timeoutSeconds: draft.timeoutSeconds,
            failureThreshold: draft.failureThreshold,
            retentionDays: draft.retentionDays,
            notify: draft.notify,
            enabled: draft.enabled
        });
        if (!row) throw new FeatureError('not_found', 'Uptime service not found');
        ctx.audit({
            action: 'uptime.update',
            description: `Service surveillé modifié : « ${draft.name} »`,
            metadata: { serviceId: row.id }
        });
        return { service: await toOneService(ctx, row) };
    }
});

export const uptimeSetEnabledFeature: FeatureDefinition<
    typeof uptimeSetEnabled.command,
    typeof uptimeSetEnabled.input,
    typeof uptimeSetEnabled.output
> = defineFeature({
    ...uptimeSetEnabled,
    mutates: true,
    handler: async (ctx, input) => {
        await loadService(ctx, input.id);
        const row = await ctx.db.uptimeServices.setEnabled(input.id, ctx.workspaceId, input.enabled);
        if (!row) throw new FeatureError('not_found', 'Uptime service not found');
        if (!input.enabled) {
            // Close any ongoing outage: we stop watching, so leaving it open
            // would keep growing an "en cours depuis…" nobody is measuring.
            const open = await ctx.db.uptimeHistory.openIncident(input.id);
            if (open) await ctx.db.uptimeHistory.closeIncident(open.id, Math.floor(Date.now() / 1000));
        }
        return { service: await toOneService(ctx, row) };
    }
});

export const uptimeRemoveFeature: FeatureDefinition<
    typeof uptimeRemove.command,
    typeof uptimeRemove.input,
    typeof uptimeRemove.output
> = defineFeature({
    ...uptimeRemove,
    mutates: true,
    handler: async (ctx, input) => {
        await loadService(ctx, input.id);
        // History, rollup and incidents go with it (ON DELETE CASCADE).
        await ctx.db.uptimeServices.delete(input.id, ctx.workspaceId);
        ctx.audit({
            action: 'uptime.remove',
            description: 'Service surveillé supprimé',
            metadata: { serviceId: input.id }
        });
        return { id: input.id };
    }
});

export const uptimeReorderFeature: FeatureDefinition<
    typeof uptimeReorder.command,
    typeof uptimeReorder.input,
    typeof uptimeReorder.output
> = defineFeature({
    ...uptimeReorder,
    mutates: true,
    handler: async (ctx, input) => {
        await ctx.db.uptimeServices.reorder(ctx.workspaceId, input.ids);
        return { ids: input.ids };
    }
});

export const uptimeCheckNowFeature: FeatureDefinition<
    typeof uptimeCheckNow.command,
    typeof uptimeCheckNow.input,
    typeof uptimeCheckNow.output
> = defineFeature({
    ...uptimeCheckNow,
    mutates: true,
    handler: async (ctx, input) => {
        const row = await loadService(ctx, input.id);
        // Same code path as the scheduler, so a manual check counts in the
        // history, the rollup and the incident log exactly like an automatic one.
        await monitor(ctx).runOne(row);
        return { service: await toOneService(ctx, await loadService(ctx, input.id)) };
    }
});

/** Bucket size and window start for a range — the whole history policy. */
function historyWindow(range: UptimeRange, now: number): { resolution: UptimeResolution; since: number } {
    switch (range) {
        case '24h':
            return { resolution: 'raw', since: now - DAY };
        case '7d':
            return { resolution: 'hour', since: now - 7 * DAY };
        case '30d':
            return { resolution: 'hour', since: now - 30 * DAY };
        case '90d':
            return { resolution: 'day', since: now - 90 * DAY };
        case '1y':
            return { resolution: 'day', since: now - 365 * DAY };
        case 'all':
            return { resolution: 'day', since: 0 };
    }
}

/** Hard cap on a raw series, so a 30 s cadence can't flood the socket. */
const RAW_POINTS_MAX = 3000;

export const uptimeHistoryFeature: FeatureDefinition<
    typeof uptimeHistory.command,
    typeof uptimeHistory.input,
    typeof uptimeHistory.output
> = defineFeature({
    ...uptimeHistory,
    handler: async (ctx, input) => {
        await loadService(ctx, input.id);
        const now = Math.floor(Date.now() / 1000);
        const { resolution, since } = historyWindow(input.range, now);
        const history = ctx.db.uptimeHistory;
        let points: UptimePoint[];
        if (resolution === 'raw') points = await history.rawPoints(input.id, since, RAW_POINTS_MAX);
        else if (resolution === 'hour') points = await history.hourlyPoints(input.id, since);
        else points = await history.dailyPoints(input.id, since);
        return { resolution, points };
    }
});

export const uptimeChecksFeature: FeatureDefinition<
    typeof uptimeChecks.command,
    typeof uptimeChecks.input,
    typeof uptimeChecks.output
> = defineFeature({
    ...uptimeChecks,
    handler: async (ctx, input) => {
        await loadService(ctx, input.id);
        const rows = await ctx.db.uptimeHistory.listChecks(input.id, input.filter, input.limit, input.before);
        return {
            checks: await Promise.all(
                rows.map(async (row) => ({
                    at: row.checked_at,
                    up: row.up === 1,
                    httpStatus: row.http_status,
                    responseMs: row.response_ms,
                    error: await decryptError(ctx.secure.open, row.error)
                }))
            )
        };
    }
});

export const uptimeCheckStatsFeature: FeatureDefinition<
    typeof uptimeCheckStats.command,
    typeof uptimeCheckStats.input,
    typeof uptimeCheckStats.output
> = defineFeature({
    ...uptimeCheckStats,
    handler: async (ctx, input) => {
        await loadService(ctx, input.id);
        return { stats: await ctx.db.uptimeHistory.checkStats(input.id, input.filter) };
    }
});

export const uptimeIncidentsFeature: FeatureDefinition<
    typeof uptimeIncidents.command,
    typeof uptimeIncidents.input,
    typeof uptimeIncidents.output
> = defineFeature({
    ...uptimeIncidents,
    handler: async (ctx, input) => {
        await loadService(ctx, input.id);
        const rows = await ctx.db.uptimeHistory.listIncidents(input.id, input.limit);
        return { incidents: await Promise.all(rows.map((row) => toIncident(ctx.secure.open, row))) };
    }
});

export const uptimeGetSettingsFeature: FeatureDefinition<
    typeof uptimeGetSettings.command,
    typeof uptimeGetSettings.input,
    typeof uptimeGetSettings.output
> = defineFeature({
    ...uptimeGetSettings,
    handler: async (ctx) => ({ settings: await getNotificationSettings(ctx, 'uptime') })
});

export const uptimeSetSettingsFeature: FeatureDefinition<
    typeof uptimeSetSettings.command,
    typeof uptimeSetSettings.input,
    typeof uptimeSetSettings.output
> = defineFeature({
    ...uptimeSetSettings,
    mutates: true,
    handler: async (ctx, input) => {
        if (input.mailAccountId !== null) {
            const account = await ctx.db.mailAccounts.findById(input.mailAccountId, ctx.workspaceId);
            if (!account) throw new FeatureError('not_found', 'Compte mail introuvable');
            if (account.security_tier !== 'open') {
                throw new FeatureError(
                    'validation',
                    'Un compte « guarded » ne peut pas envoyer d’alertes automatiques : choisissez un compte « open »'
                );
            }
        }
        const settings = await setNotificationSettings(ctx, 'uptime', input);
        ctx.audit({
            action: 'uptime.setSettings',
            description: 'Notifications de disponibilité modifiées',
            metadata: { email: input.emailEnabled, webhook: input.webhookEnabled }
        });
        return { settings };
    }
});

export const uptimeTestNotificationFeature: FeatureDefinition<
    typeof uptimeTestNotification.command,
    typeof uptimeTestNotification.input,
    typeof uptimeTestNotification.output
> = defineFeature({
    ...uptimeTestNotification,
    handler: async (ctx) => monitor(ctx).sendTestAlert(ctx.workspaceId)
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const uptimeFeatures: FeatureDefinition<string, any, any>[] = [
    uptimeListFeature,
    uptimeCountFeature,
    uptimeAddFeature,
    uptimeUpdateFeature,
    uptimeSetEnabledFeature,
    uptimeRemoveFeature,
    uptimeReorderFeature,
    uptimeCheckNowFeature,
    uptimeHistoryFeature,
    uptimeChecksFeature,
    uptimeCheckStatsFeature,
    uptimeIncidentsFeature,
    uptimeGetSettingsFeature,
    uptimeSetSettingsFeature,
    uptimeTestNotificationFeature
];
