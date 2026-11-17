import { appStoresRevenue, appStoresStats } from '../contracts/commands';
import type {
    AppStore,
    AppStoresMetrics,
    AppStoresPoint,
    AppStoresRange,
    AppStoresResolution,
    AppStoresRevenueTotal,
    AppStoresWindow
} from '../contracts/domain';
import { defineSdkFeature } from '@deveye/types/sdk/server';

import { dataUntilOf } from './apps';
import { DAY_SECONDS, utcToday } from './days';
import type { DailyRow, ListingKey, ListingRow, RevenueRow } from './repo';
import { loadApp, type Ctx } from './_shared';

/**
 * Les chiffres d'une app, sur une fenêtre et la précédente de même longueur.
 * La fenêtre finit au dernier jour complet commun à ses stores, pas à
 * aujourd'hui : les stores publient avec un ou deux jours de retard. Les
 * montants n'ont qu'une commande, gardée par le droit Revenus.
 */

const RANGE_SHAPE: Record<AppStoresRange, { buckets: number; size: number; resolution: AppStoresResolution }> = {
    '7d': { buckets: 7, size: 1, resolution: 'day' },
    '30d': { buckets: 30, size: 1, resolution: 'day' },
    '90d': { buckets: 90, size: 1, resolution: 'day' },
    // Cinquante-deux semaines pleines : l'année rattrapée les contient.
    '365d': { buckets: 52, size: 7, resolution: 'week' }
};

/** Les jours d'une fenêtre et de la précédente, bornes comprises. */
export interface DayWindow {
    fromDay: number;
    toDay: number;
    previousFromDay: number;
    buckets: number;
    size: number;
    resolution: AppStoresResolution;
    dataUntil: number | null;
}

export function dayWindow(range: AppStoresRange, dataUntil: number | null, today: number): DayWindow {
    const shape = RANGE_SHAPE[range];
    const toDay = dataUntil ?? today - 1;
    const span = shape.buckets * shape.size;
    const fromDay = toDay - span + 1;
    return {
        fromDay,
        toDay,
        previousFromDay: fromDay - span,
        buckets: shape.buckets,
        size: shape.size,
        resolution: shape.resolution,
        dataUntil
    };
}

export function withData(listings: readonly ListingRow[]): ListingRow[] {
    return listings.filter((l) => l.synced_day !== null && l.history_from !== null);
}

/** Une fiche couvre un jour qu'elle a relevé, même vide. */
function covers(listing: ListingRow | undefined, day: number): boolean {
    return (
        listing !== undefined &&
        listing.history_from !== null &&
        listing.synced_day !== null &&
        listing.history_from <= day &&
        day <= listing.synced_day
    );
}

export function contractWindow(
    range: AppStoresRange,
    window: DayWindow,
    listings: readonly ListingRow[]
): AppStoresWindow {
    const sources = withData(listings);
    return {
        range,
        resolution: window.resolution,
        from: window.fromDay * DAY_SECONDS,
        to: (window.toDay + 1) * DAY_SECONDS,
        bucket: window.size * DAY_SECONDS,
        dataUntil: window.dataUntil === null ? null : window.dataUntil * DAY_SECONDS,
        previousCovered:
            sources.length > 0 && sources.every((l) => (l.history_from ?? Infinity) <= window.previousFromDay)
    };
}

/** Les taux d'un ensemble de jours, pondérés par les utilisateurs de chacun. */
export function weighted(
    rows: readonly Pick<DailyRow, 'store' | 'crash_rate' | 'anr_rate' | 'vitals_users'>[],
    metric: 'crash_rate' | 'anr_rate'
): number | null {
    let sum = 0;
    let weight = 0;
    for (const row of rows) {
        const rate = row[metric];
        if (rate === null || row.store !== 'google') continue;
        const users = row.vitals_users !== null && row.vitals_users > 0 ? row.vitals_users : 1;
        sum += Number(rate) * users;
        weight += users;
    }
    return weight > 0 ? sum / weight : null;
}

/** Le total d'un store sur des jours ; `null` quand la fiche manque ou ne couvre aucun de ces jours. */
export function downloadsIn(
    listing: ListingRow | undefined,
    rows: readonly Pick<DailyRow, 'store' | 'day' | 'downloads'>[],
    from: number,
    to: number
): number | null {
    let any = false;
    for (let day = from; day <= to; day++) {
        if (covers(listing, day)) {
            any = true;
            break;
        }
    }
    if (!any || !listing) return null;
    return rows
        .filter((r) => r.store === listing.store && r.day >= from && r.day <= to && covers(listing, r.day))
        .reduce((total, r) => total + Math.max(0, r.downloads ?? 0), 0);
}

/**
 * La dernière note relevée de la fenêtre ; `later`, la première relevée après
 * elle à défaut. Apple ne publie que la note du moment, relevée chaque jour
 * depuis le branchement : elle peut ne commencer qu'après la fin d'une fenêtre
 * que le retard de Google arrête plus tôt.
 */
function ratingOf(rows: readonly DailyRow[], store: AppStore, from: number, to: number, later: boolean): number | null {
    let found: DailyRow | null = null;
    for (const row of rows) {
        if (row.store !== store || row.rating_avg === null || row.day < from || row.day > to) continue;
        if (found === null || row.day > found.day) found = row;
    }
    for (const row of later && found === null ? rows : []) {
        if (row.store !== store || row.rating_avg === null || row.day <= to) continue;
        if (found === null || row.day < found.day) found = row;
    }
    return found === null ? null : Math.min(5, Math.max(0, Number(found.rating_avg)));
}

/** `current` : la fenêtre affichée, dont la note peut se prendre juste après elle (voir `ratingOf`). */
export function metricsOf(
    listings: readonly ListingRow[],
    rows: readonly DailyRow[],
    from: number,
    to: number,
    reviews: number,
    current: boolean
): AppStoresMetrics {
    const of = (store: AppStore) => listings.find((l) => l.store === store);
    const inWindow = rows.filter((r) => r.day >= from && r.day <= to);
    return {
        downloads: {
            apple: downloadsIn(of('apple'), rows, from, to),
            google: downloadsIn(of('google'), rows, from, to)
        },
        rating: {
            apple: of('apple') ? ratingOf(rows, 'apple', from, to, current) : null,
            google: of('google') ? ratingOf(rows, 'google', from, to, current) : null
        },
        reviews,
        crashRate: weighted(inWindow, 'crash_rate'),
        anrRate: weighted(inWindow, 'anr_rate')
    };
}

export function pointsOf(
    listings: readonly ListingRow[],
    rows: readonly DailyRow[],
    window: DayWindow
): AppStoresPoint[] {
    const of = (store: AppStore) => listings.find((l) => l.store === store);
    return Array.from({ length: window.buckets }, (_, k) => {
        const from = window.fromDay + k * window.size;
        const to = from + window.size - 1;
        const inBucket = rows.filter((r) => r.day >= from && r.day <= to);
        return {
            at: from * DAY_SECONDS,
            appleDownloads: downloadsIn(of('apple'), rows, from, to),
            googleDownloads: downloadsIn(of('google'), rows, from, to),
            crashRate: weighted(inBucket, 'crash_rate'),
            anrRate: weighted(inBucket, 'anr_rate')
        };
    });
}

/**
 * Les revenus par store et par devise : Apple en produits nets, Google en
 * ventes estimées avant sa commission. La période précédente d'un store se
 * tait quand sa fiche ne la couvre pas.
 */
export function revenueOf(
    listings: readonly ListingRow[],
    rows: readonly RevenueRow[],
    window: DayWindow
): { totals: AppStoresRevenueTotal[]; points: { at: number; store: AppStore; currency: string; amount: number }[] } {
    const stores = new Set(listings.map((l) => l.store));
    const kept = rows.filter((r) => stores.has(r.store));
    const keys = [...new Set(kept.map((r) => `${r.store}:${r.currency}`))].sort();
    const round = (value: number) => Math.round(value * 1000) / 1000;
    const totals: AppStoresRevenueTotal[] = keys.map((key) => {
        const [store, currency] = key.split(':') as [AppStore, string];
        const mine = kept.filter((r) => r.store === store && r.currency === currency);
        const current = mine.filter((r) => r.day >= window.fromDay && r.day <= window.toDay);
        const previous = mine.filter((r) => r.day >= window.previousFromDay && r.day < window.fromDay);
        const listing = listings.find((l) => l.store === store);
        const previousCovered =
            listing !== undefined && listing.history_from !== null && listing.history_from <= window.previousFromDay;
        return {
            store,
            currency,
            amount: round(current.reduce((sum, r) => sum + Number(r.amount), 0)),
            previous: previousCovered ? round(previous.reduce((sum, r) => sum + Number(r.amount), 0)) : null,
            units: current.reduce((sum, r) => sum + Number(r.units), 0)
        };
    });
    const points = totals.flatMap(({ store, currency }) =>
        Array.from({ length: window.buckets }, (_, k) => {
            const from = window.fromDay + k * window.size;
            const to = from + window.size - 1;
            const amount = kept
                .filter((r) => r.store === store && r.currency === currency && r.day >= from && r.day <= to)
                .reduce((sum, r) => sum + Number(r.amount), 0);
            return { at: from * DAY_SECONDS, store, currency, amount: round(amount) };
        })
    );
    return { totals, points };
}

export const keysOf = (listings: readonly ListingRow[]): ListingKey[] => listings.map((l) => [l.app_id, l.store]);

/** Les lignes d'un seul store quand la lecture le demande, toutes sinon. */
export function ofStore<T extends { store: AppStore }>(rows: readonly T[], store: AppStore | undefined): T[] {
    return store ? rows.filter((row) => row.store === store) : [...rows];
}

export const appStoresStatsFeatures = [
    defineSdkFeature({
        ...appStoresStats,
        access: { item: 'appId' },
        handler: async (ctx: Ctx, input) => {
            await loadApp(ctx, input.appId);
            const listings = ofStore(await ctx.repo.listListingsOfApps([input.appId]), input.store);
            const today = utcToday(Date.now());
            const window = dayWindow(input.range, dataUntilOf(withData(listings)), today);
            const [rows, counts, countries] = await Promise.all([
                // Jusqu'à aujourd'hui, au-delà de la fenêtre : de quoi trouver une note relevée après elle.
                ctx.repo.dailyRows(input.appId, window.previousFromDay, today).then((all) => ofStore(all, input.store)),
                ctx.repo.reviewCounts(
                    keysOf(listings),
                    window.previousFromDay * DAY_SECONDS,
                    window.fromDay * DAY_SECONDS,
                    (window.toDay + 1) * DAY_SECONDS
                ),
                ctx.repo.countryTotals(keysOf(listings), window.fromDay, window.toDay)
            ]);
            const reviewStars = [1, 2, 3, 4, 5].map((stars) => counts.find((c) => c.rating === stars)?.current ?? 0);
            const previousReviews = counts.reduce((sum, c) => sum + c.previous, 0);
            return {
                stats: {
                    ...contractWindow(input.range, window, listings),
                    metrics: metricsOf(
                        listings,
                        rows,
                        window.fromDay,
                        window.toDay,
                        reviewStars.reduce((a, b) => a + b, 0),
                        true
                    ),
                    previous: metricsOf(
                        listings,
                        rows,
                        window.previousFromDay,
                        window.fromDay - 1,
                        previousReviews,
                        false
                    ),
                    points: pointsOf(listings, rows, window),
                    previousPoints: pointsOf(listings, rows, { ...window, fromDay: window.previousFromDay }),
                    reviewStars,
                    countries: countries.filter((c) => c.downloads > 0)
                }
            };
        }
    }),
    defineSdkFeature({
        ...appStoresRevenue,
        // Une ressource à part : sans le droit, aucun montant ne sort, surcharge de l'app comprise.
        access: { extras: ['revenue'], item: 'appId' },
        handler: async (ctx: Ctx, input) => {
            await loadApp(ctx, input.appId);
            const listings = ofStore(await ctx.repo.listListingsOfApps([input.appId]), input.store);
            const window = dayWindow(input.range, dataUntilOf(withData(listings)), utcToday(Date.now()));
            const rows = await ctx.repo.revenueRows(keysOf(listings), window.previousFromDay, window.toDay);
            return {
                revenue: { ...contractWindow(input.range, window, listings), ...revenueOf(listings, rows, window) }
            };
        }
    })
];
