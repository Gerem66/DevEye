import {
    uptimeAdd,
    uptimeCheckNow,
    uptimeCheckStats,
    uptimeChecks,
    uptimeCount,
    uptimeHistory,
    uptimeIncidents,
    uptimeList,
    uptimeRemove,
    uptimeReorder,
    uptimeSetEnabled,
    uptimeUpdate
} from '../contracts/commands';
import type { UptimePoint, UptimeRange, UptimeResolution, UptimeService, UptimeServiceRow } from '../contracts/domain';
import { defineSdkFeature, FeatureError } from '@deveye/types/sdk/server';

import {
    decryptError,
    encryptService,
    monitor,
    toIncident,
    toService,
    EMPTY_STATS,
    type Ctx,
    type ServiceStats
} from './_shared';
import type { UptimeWindowStat } from './repo';

const DAY = 86400;

/**
 * Un service visible depuis cet espace : le sien, ou un que l'on y projette.
 * Lève `not_found` sinon.
 *
 * `level` décide de la garde : `ctx.items.assert` (l'ex `assertItem`) refuse
 * en plus les services qu'une restriction de rôle masque ou passe en lecture
 * seule. La feature seule ne suffit plus à répondre « ce service-là m'est-il
 * ouvert ? ».
 */
async function loadService(ctx: Ctx, id: number, level: 'read' | 'write' = 'read'): Promise<UptimeServiceRow> {
    const row = await ctx.repo.services.findVisible(id, ctx.workspaceId);
    if (!row) throw new FeatureError('not_found', 'Uptime service not found');
    await ctx.items.assert(id, level);
    return row;
}

function ratio(stat: UptimeWindowStat | undefined): number | null {
    return stat && stat.checks > 0 ? stat.upChecks / stat.checks : null;
}

/**
 * Ratios for every one of the caller's services, in three grouped queries (one
 * per window) rather than three per service.
 *
 * Only the 24 h figure reads the raw pings; the multi-day ones come from the
 * daily rollup (a handful of rows per service instead of tens of thousands, and
 * still complete for a service whose raw history has been pruned). They are
 * therefore whole UTC days rather than a rolling window, which is also how
 * uptime is conventionally reported.
 */
async function loadStats(ctx: Ctx, now: number): Promise<Map<number, ServiceStats>> {
    const today = Math.floor(now / DAY) * DAY;
    const [day, week, month] = await Promise.all([
        ctx.repo.history.windowStats(ctx.workspaceId, now - DAY),
        ctx.repo.history.dailyWindowStats(ctx.workspaceId, today - 6 * DAY),
        ctx.repo.history.dailyWindowStats(ctx.workspaceId, today - 29 * DAY)
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

/**
 * Build the DTOs for a set of rows, folding in stats and ongoing outages.
 *
 * **Le codec est choisi ligne par ligne** : un service projeté depuis un autre
 * espace reste chiffré sous la clé de cet espace-là, et le déchiffrer avec celle
 * d'ici rendrait un nom vide plutôt qu'une erreur (un service sans nom, qu'on
 * croirait mal enregistré). `ctx.sharing.scope()` est l'ex `shareScope(ctx,
 * 'uptime')` : mêmes `foreignIds`, `homeOf` et `cipherFor`.
 */
async function toServices(ctx: Ctx, rows: UptimeServiceRow[]): Promise<UptimeService[]> {
    const now = Math.floor(Date.now() / 1000);
    const [stats, open, shares] = await Promise.all([
        loadStats(ctx, now),
        ctx.repo.history.listOpenIncidents(ctx.workspaceId),
        ctx.sharing.scope()
    ]);
    const downSince = new Map(open.map((i) => [i.service_id, i.started_at]));
    return Promise.all(
        rows.map(async (row) =>
            toService(
                await shares.cipherFor(row.id),
                row,
                stats.get(row.id) ?? EMPTY_STATS,
                downSince.get(row.id) ?? null,
                row.workspace_id !== ctx.workspaceId
            )
        )
    );
}

/** Single-service variant, used by every command that returns one service. */
async function toOneService(ctx: Ctx, row: UptimeServiceRow): Promise<UptimeService> {
    const [service] = await toServices(ctx, [row]);
    return service;
}

/** Bucket size and window start for a range: the whole history policy. */
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

export const uptimeHandlers = [
    defineSdkFeature({
        ...uptimeList,
        handler: async (ctx: Ctx) => {
            const rows = await ctx.repo.services.listVisible(ctx.workspaceId);
            // Les services qu'une restriction masque pour ce rôle disparaissent de
            // la liste plutôt que d'y figurer grisés : une ligne qu'on voit sans
            // pouvoir l'ouvrir apprend déjà qu'elle existe.
            const hidden = await ctx.items.restrictions();
            const visible = rows.filter((r) => hidden.get(r.id) !== 'none');
            return { services: await toServices(ctx, visible) };
        }
    }),
    defineSdkFeature({
        ...uptimeCount,
        handler: async (ctx: Ctx) => {
            // Les mêmes lignes que la liste (projetées comprises, restrictions
            // déduites) : une carte qui compte moins que la liste qu'elle ouvre se
            // lit comme un bug, dans un sens comme dans l'autre.
            const rows = await ctx.repo.services.listVisible(ctx.workspaceId);
            const hidden = await ctx.items.restrictions();
            const visible = rows.filter((r) => hidden.get(r.id) !== 'none' && r.enabled === 1);
            return {
                total: visible.length,
                up: visible.filter((r) => r.status === 'up').length,
                down: visible.filter((r) => r.status === 'down').length
            };
        }
    }),
    defineSdkFeature({
        ...uptimeAdd,
        access: { level: 'write' },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            const draft = input.service;
            const row = await ctx.repo.services.create({
                userId: ctx.userId,
                workspaceId: ctx.workspaceId,
                content: await encryptService(ctx.cipher(), {
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
                enabled: draft.enabled
            });
            ctx.audit({
                action: 'uptime.add',
                description: `Service surveillé ajouté : « ${draft.name} »`,
                metadata: { serviceId: row.id }
            });
            // Probe straight away so the card doesn't sit on "jamais testé" until
            // the first tick: the user just told us the URL, show them if it works.
            // A service created already paused is left alone, as the user asked.
            if (row.enabled === 1) await monitor().runOne(row);
            return { service: await toOneService(ctx, await loadService(ctx, row.id)) };
        }
    }),
    defineSdkFeature({
        ...uptimeUpdate,
        access: { level: 'write' },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            const existing = await loadService(ctx, input.id, 'write');
            const draft = input.service;
            // Réécrit sous la clé de son espace d'origine : le chiffrer avec celle
            // d'ici le rendrait illisible chez lui, c'est-à-dire perdu pour tout le
            // monde y compris l'ordonnanceur qui le sonde.
            const shares = await ctx.sharing.scope();
            const row = await ctx.repo.services.update(input.id, existing.workspace_id, {
                content: await encryptService(await shares.cipherFor(input.id), {
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
    }),
    defineSdkFeature({
        ...uptimeSetEnabled,
        access: { level: 'write' },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            await loadService(ctx, input.id);
            const row = await ctx.repo.services.setEnabled(input.id, ctx.workspaceId, input.enabled);
            if (!row) throw new FeatureError('not_found', 'Uptime service not found');
            if (!input.enabled) {
                // Close any ongoing outage: we stop watching, so leaving it open
                // would keep growing an "en cours depuis…" nobody is measuring.
                const open = await ctx.repo.history.openIncident(input.id);
                if (open) await ctx.repo.history.closeIncident(open.id, Math.floor(Date.now() / 1000));
            }
            return { service: await toOneService(ctx, row) };
        }
    }),
    defineSdkFeature({
        ...uptimeRemove,
        access: { level: 'write' },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            const existing = await loadService(ctx, input.id, 'write');
            // Supprimer depuis un espace qui ne fait que le **voir** détruirait la
            // donnée d'un autre. Retirer la projection, oui (c'est `share.set`) ;
            // détruire l'élément, non, et pas depuis ici.
            if (existing.workspace_id !== ctx.workspaceId) {
                throw new FeatureError(
                    'forbidden',
                    'Ce service appartient à un autre espace. Retirez-le d’ici depuis ses réglages de partage, ou supprimez-le depuis son espace d’origine.'
                );
            }
            // History, rollup and incidents go with it (ON DELETE CASCADE).
            await ctx.repo.services.delete(input.id, ctx.workspaceId);
            // Projections, restrictions et route de notification ne sont rattachées
            // par aucune clé étrangère : l'élément vit dans une table différente
            // selon la feature. Sans ce ménage, une ligne orpheline s'appliquerait
            // au prochain service à hériter de l'identifiant ; pour la route, avec
            // en prime un « réglé à la main » qui l'empêcherait d'hériter d'Uptime.
            // `ctx.items.forget` fait les deux (l'ex `itemSharing.forgetItem` +
            // `notificationChannels.clearRoute`).
            await ctx.items.forget(input.id);
            ctx.audit({
                action: 'uptime.remove',
                description: 'Service surveillé supprimé',
                metadata: { serviceId: input.id }
            });
            return { id: input.id };
        }
    }),
    defineSdkFeature({
        ...uptimeReorder,
        access: { level: 'write' },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            await ctx.repo.services.reorder(ctx.workspaceId, input.ids);
            return { ids: input.ids };
        }
    }),
    defineSdkFeature({
        ...uptimeCheckNow,
        access: { level: 'write' },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            const row = await loadService(ctx, input.id);
            // Same code path as the scheduler, so a manual check counts in the
            // history, the rollup and the incident log exactly like an automatic one.
            await monitor().runOne(row);
            return { service: await toOneService(ctx, await loadService(ctx, input.id)) };
        }
    }),
    defineSdkFeature({
        ...uptimeHistory,
        handler: async (ctx: Ctx, input) => {
            await loadService(ctx, input.id);
            const now = Math.floor(Date.now() / 1000);
            const { resolution, since } = historyWindow(input.range, now);
            const history = ctx.repo.history;
            let points: UptimePoint[];
            if (resolution === 'raw') points = await history.rawPoints(input.id, since, RAW_POINTS_MAX);
            else if (resolution === 'hour') points = await history.hourlyPoints(input.id, since);
            else points = await history.dailyPoints(input.id, since);
            return { resolution, points };
        }
    }),
    defineSdkFeature({
        ...uptimeChecks,
        handler: async (ctx: Ctx, input) => {
            await loadService(ctx, input.id);
            const rows = await ctx.repo.history.listChecks(input.id, input.filter, input.limit, input.before);
            return {
                checks: await Promise.all(
                    rows.map(async (row) => ({
                        at: row.checked_at,
                        up: row.up === 1,
                        httpStatus: row.http_status,
                        responseMs: row.response_ms,
                        error: await decryptError(ctx.cipher(), row.error)
                    }))
                )
            };
        }
    }),
    defineSdkFeature({
        ...uptimeCheckStats,
        handler: async (ctx: Ctx, input) => {
            await loadService(ctx, input.id);
            return { stats: await ctx.repo.history.checkStats(input.id, input.filter) };
        }
    }),
    defineSdkFeature({
        ...uptimeIncidents,
        handler: async (ctx: Ctx, input) => {
            await loadService(ctx, input.id);
            const rows = await ctx.repo.history.listIncidents(input.id, input.limit);
            return { incidents: await Promise.all(rows.map((row) => toIncident(ctx.cipher(), row))) };
        }
    })
];
