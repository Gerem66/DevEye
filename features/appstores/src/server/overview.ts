import { appStoresOverview } from '../contracts/commands';
import {
    APPSTORES_ANR_THRESHOLD,
    APPSTORES_CRASH_THRESHOLD,
    APPSTORES_VITALS_WINDOW_DAYS,
    type AppStore,
    type AppStoresMetrics,
    type AppStoresOverview,
    type AppStoresPoint,
    type AppStoresRevenueTotal
} from '../contracts/domain';
import { defineSdkFeature } from '@deveye/types/sdk/server';

import { dataUntilOf } from './apps';
import { DAY_SECONDS, utcToday } from './days';
import type { ListingRow, RevenueRow } from './repo';
import { toReview } from './reviews';
import { contractWindow, dayWindow, downloadsIn, keysOf, weighted, withData, type DayWindow } from './stats';
import { iconOf, readApp, type Ctx } from './_shared';

/**
 * La vue d'ensemble : toutes les apps visibles sur une même fenêtre, lue en
 * base seulement. Elle finit au dernier jour commun aux fiches, sauf celles
 * dont les chiffres ont décroché de leur store : une clé cassée ne fige pas
 * la vue des autres, et la fiche laissée de côté est nommée.
 */

/** Le retard, en jours, au-delà duquel une fiche décroche des autres fiches de son store. */
const STALE_DAYS = 3;
/** Les avis sans réponse montrés d'emblée. */
const REVIEWS_SHOWN = 5;
/** De quoi trouver les 28 derniers jours mesurés de chaque app, que Google publie avec quelques jours de retard. */
const VITALS_DAYS = APPSTORES_VITALS_WINDOW_DAYS + 7;

type DownloadRow = { app_id: number; store: AppStore; day: number; downloads: number | null };

/** Les fiches comptées, et celles dont le dernier jour relevé traîne derrière celui de leurs pairs. */
export function splitStale(listings: readonly ListingRow[]): { kept: ListingRow[]; left: ListingRow[] } {
    const data = withData(listings);
    const latest = new Map<AppStore, number>();
    for (const listing of data) {
        latest.set(listing.store, Math.max(latest.get(listing.store) ?? 0, listing.synced_day ?? 0));
    }
    const kept = data.filter((l) => (l.synced_day ?? 0) >= (latest.get(l.store) ?? 0) - STALE_DAYS);
    return { kept, left: data.filter((l) => !kept.includes(l)) };
}

/** Le total de fiches sur des jours, chacune sur ce qu'elle couvre ; `null` quand aucune n'en couvre un seul. */
function downloadsOver(
    listings: readonly ListingRow[],
    rows: ReadonlyMap<number, DownloadRow[]>,
    from: number,
    to: number
): number | null {
    let total: number | null = null;
    for (const listing of listings) {
        const value = downloadsIn(listing, rows.get(listing.app_id) ?? [], from, to);
        if (value !== null) total = (total ?? 0) + value;
    }
    return total;
}

const ofStore = (listings: readonly ListingRow[], store: AppStore) => listings.filter((l) => l.store === store);

function metricsOver(
    listings: readonly ListingRow[],
    rows: ReadonlyMap<number, DownloadRow[]>,
    from: number,
    to: number,
    reviews: number
): AppStoresMetrics {
    return {
        downloads: {
            apple: downloadsOver(ofStore(listings, 'apple'), rows, from, to),
            google: downloadsOver(ofStore(listings, 'google'), rows, from, to)
        },
        rating: { apple: null, google: null },
        reviews,
        crashRate: null,
        anrRate: null
    };
}

function pointsOver(
    listings: readonly ListingRow[],
    rows: ReadonlyMap<number, DownloadRow[]>,
    window: DayWindow
): AppStoresPoint[] {
    return Array.from({ length: window.buckets }, (_, k) => {
        const from = window.fromDay + k * window.size;
        const to = from + window.size - 1;
        return {
            at: from * DAY_SECONDS,
            appleDownloads: downloadsOver(ofStore(listings, 'apple'), rows, from, to),
            googleDownloads: downloadsOver(ofStore(listings, 'google'), rows, from, to),
            crashRate: null,
            anrRate: null
        };
    });
}

/**
 * Les revenus par store et par devise ; l'écart seulement si chaque fiche du
 * store couvre la période d'avant. Apple et Google ne se somment toujours pas.
 */
export function revenueTotals(
    listings: readonly ListingRow[],
    rows: readonly RevenueRow[],
    window: DayWindow
): AppStoresRevenueTotal[] {
    const round = (value: number) => Math.round(value * 1000) / 1000;
    const keys = [...new Set(rows.map((r) => `${r.store}:${r.currency}`))].sort();
    return keys.map((key) => {
        const [store, currency] = key.split(':') as [AppStore, string];
        const mine = rows.filter((r) => r.store === store && r.currency === currency);
        const current = mine.filter((r) => r.day >= window.fromDay && r.day <= window.toDay);
        const previous = mine.filter((r) => r.day >= window.previousFromDay && r.day < window.fromDay);
        const covered = ofStore(listings, store).every(
            (l) => l.history_from !== null && l.history_from <= window.previousFromDay
        );
        return {
            store,
            currency,
            amount: round(current.reduce((sum, r) => sum + Number(r.amount), 0)),
            previous: covered ? round(previous.reduce((sum, r) => sum + Number(r.amount), 0)) : null,
            units: current.reduce((sum, r) => sum + Number(r.units), 0)
        };
    });
}

/** Les apps au-dessus d'un seuil de Google, sur les 28 derniers jours qu'il a mesurés pour chacune. */
export function alertsOf(
    rows: readonly {
        app_id: number;
        day: number;
        crash_rate: number | null;
        anr_rate: number | null;
        vitals_users: number | null;
    }[]
): { appId: number; crashRate: number | null; anrRate: number | null }[] {
    const alerts: { appId: number; crashRate: number | null; anrRate: number | null }[] = [];
    for (const appId of [...new Set(rows.map((r) => r.app_id))]) {
        const mine = rows.filter((r) => r.app_id === appId).map((r) => ({ ...r, store: 'google' as const }));
        const last = Math.max(...mine.map((r) => r.day));
        const window = mine.filter((r) => r.day > last - APPSTORES_VITALS_WINDOW_DAYS);
        const crashRate = weighted(window, 'crash_rate');
        const anrRate = weighted(window, 'anr_rate');
        if ((crashRate ?? 0) > APPSTORES_CRASH_THRESHOLD || (anrRate ?? 0) > APPSTORES_ANR_THRESHOLD) {
            alerts.push({ appId, crashRate, anrRate });
        }
    }
    return alerts;
}

export const appStoresOverviewFeatures = [
    defineSdkFeature({
        ...appStoresOverview,
        handler: async (ctx: Ctx, input): Promise<{ overview: AppStoresOverview }> => {
            const hidden = await ctx.items.restrictions();
            const apps = (await ctx.repo.listVisibleApps(ctx.workspaceId)).filter(
                (row) => hidden.get(String(row.id)) !== 'none'
            );
            const shares = await ctx.sharing.scope();
            const ciphers = new Map(
                await Promise.all(apps.map(async (row) => [row.id, await shares.cipherFor(String(row.id))] as const))
            );
            const names = new Map(
                await Promise.all(
                    apps.map(async (row) => [row.id, (await readApp(ciphers.get(row.id)!, row)).name] as const)
                )
            );
            const ref = (id: number) => ({ id, name: names.get(id) ?? '' });

            const all = await ctx.repo.listListingsOfApps(apps.map((row) => row.id));
            // L'icône d'une app ne dépend pas du store choisi.
            const icons = new Map(
                await Promise.all(
                    apps.map(
                        async (row) =>
                            [
                                row.id,
                                await iconOf(
                                    ciphers.get(row.id)!,
                                    all.filter((l) => l.app_id === row.id)
                                )
                            ] as const
                    )
                )
            );
            const listings = all.filter((l) => !input.store || l.store === input.store);
            const { kept, left } = splitStale(listings);
            const today = utcToday(Date.now());
            const window = dayWindow(input.range, dataUntilOf(kept), today);
            const keptIds = [...new Set(kept.map((l) => l.app_id))];
            const earning = new Set(
                (
                    await Promise.all(
                        keptIds.map(async (id) => ((await ctx.items.canExtra(String(id), 'revenue')) ? id : null))
                    )
                ).filter((id): id is number => id !== null)
            );
            const earningListings = kept.filter((l) => earning.has(l.app_id));
            const googleIds = [...new Set(ofStore(kept, 'google').map((l) => l.app_id))];

            const [daily, counts, countries, open, vitals, revenue] = await Promise.all([
                ctx.repo.downloadsOf(keptIds, window.previousFromDay, window.toDay),
                ctx.repo.reviewCounts(
                    keysOf(kept),
                    window.previousFromDay * DAY_SECONDS,
                    window.fromDay * DAY_SECONDS,
                    (window.toDay + 1) * DAY_SECONDS
                ),
                ctx.repo.countryTotals(keysOf(kept), window.fromDay, window.toDay),
                ctx.repo.unansweredReviews(
                    keysOf(kept),
                    window.fromDay * DAY_SECONDS,
                    (window.toDay + 1) * DAY_SECONDS,
                    REVIEWS_SHOWN
                ),
                ctx.repo.vitalsOf(googleIds, today - VITALS_DAYS, today),
                ctx.repo.revenueRows(keysOf(earningListings), window.previousFromDay, window.toDay)
            ]);

            const rows = new Map<number, DownloadRow[]>();
            for (const row of daily) rows.set(row.app_id, [...(rows.get(row.app_id) ?? []), row]);
            const ranked = keptIds
                .map((id) => {
                    const mine = kept.filter((l) => l.app_id === id);
                    return {
                        ...ref(id),
                        icon: icons.get(id) ?? null,
                        downloads: downloadsOver(mine, rows, window.fromDay, window.toDay),
                        points: pointsOver(mine, rows, window).map((point) =>
                            point.appleDownloads === null && point.googleDownloads === null
                                ? null
                                : (point.appleDownloads ?? 0) + (point.googleDownloads ?? 0)
                        )
                    };
                })
                .sort((a, b) => (b.downloads ?? -1) - (a.downloads ?? -1));
            const homeOf = new Map(apps.map((row) => [row.id, row.workspace_id]));
            const replyable = (appId: number) =>
                homeOf.get(appId) === ctx.workspaceId && !ctx.quota.isPaused('apps', String(appId));

            return {
                overview: {
                    ...contractWindow(input.range, window, kept),
                    metrics: metricsOver(
                        kept,
                        rows,
                        window.fromDay,
                        window.toDay,
                        counts.reduce((sum, c) => sum + c.current, 0)
                    ),
                    previous: metricsOver(
                        kept,
                        rows,
                        window.previousFromDay,
                        window.fromDay - 1,
                        counts.reduce((sum, c) => sum + c.previous, 0)
                    ),
                    points: pointsOver(kept, rows, window),
                    previousPoints: pointsOver(kept, rows, { ...window, fromDay: window.previousFromDay }),
                    countries: countries.filter((c) => c.downloads > 0),
                    apps: ranked,
                    left: left.map((l) => ({
                        ...ref(l.app_id),
                        store: l.store,
                        dataUntil: (l.synced_day ?? 0) * DAY_SECONDS
                    })),
                    unanswered: open.total,
                    reviews: await Promise.all(
                        open.rows.map(async (row) => ({
                            ...(await toReview(ciphers.get(row.app_id)!, row)),
                            app: ref(row.app_id),
                            replyable: replyable(row.app_id)
                        }))
                    ),
                    alerts: alertsOf(vitals).map((alert) => ({
                        ...ref(alert.appId),
                        crashRate: alert.crashRate,
                        anrRate: alert.anrRate
                    })),
                    revenue:
                        earning.size === 0
                            ? null
                            : {
                                  totals: revenueTotals(earningListings, revenue, window),
                                  partial: earning.size < keptIds.length
                              }
                }
            };
        }
    })
];
