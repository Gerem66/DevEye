import type { AppStore } from '../contracts/domain';

import { createTestContext } from '@deveye/types/sdk/testing';

import type { AppRow, AppStoresRepo, ListingKey, ListingRow, ReviewRow, SourceRow } from './repo';
import { listingRef } from './_shared';

const { keys } = createTestContext();

/**
 * Le dépôt en mémoire des tests, même contrat que le vrai. Le harnais chiffre
 * à l'identité : les cellules « scellées » sont le JSON en clair.
 */

export interface DailyCell {
    app_id: number;
    store: AppStore;
    day: number;
    downloads: number | null;
    updates: number | null;
    uninstalls: number | null;
    active_devices: number | null;
    rating_avg: number | null;
    rating_count: number | null;
    crash_rate: number | null;
    anr_rate: number | null;
    vitals_users: number | null;
}

export interface RevenueCell {
    app_id: number;
    store: AppStore;
    day: number;
    currency: string;
    amount: number;
    units: number;
}

export interface CountryCell {
    app_id: number;
    store: AppStore;
    day: number;
    country: string;
    downloads: number;
}

export interface FakeDb {
    sources: SourceRow[];
    apps: AppRow[];
    listings: ListingRow[];
    daily: DailyCell[];
    revenue: RevenueCell[];
    countries: CountryCell[];
    reviews: ReviewRow[];
    /** `item_shares` : les apps projetées, et vers quel espace. */
    shares: { appId: number; workspaceId: number }[];
    /** Les méthodes appelées, dans l'ordre. */
    calls: string[];
    /** Les arguments de chaque `listDue`. */
    dueCalls: Parameters<AppStoresRepo['listDue']>[0][];
}

export type FakeRepo = AppStoresRepo & { db: FakeDb };

export function sourceRow(over: Partial<SourceRow> & { id: number }): SourceRow {
    return {
        workspace_id: 1,
        store: 'apple',
        content: JSON.stringify({
            label: `Source ${over.id}`,
            issuerId: '6a1f0c2e-0000-4000-8000-000000000001',
            keyId: 'ABCDE12345',
            vendorNumber: '87654321'
        }),
        secret_enc: '-----BEGIN PRIVATE KEY-----\nSECRET\n-----END PRIVATE KEY-----',
        capabilities: 'apps,downloads,ratings,reviews,revenue,versions',
        checked_at: 1,
        failing_since: null,
        failing_error: null,
        failing_count: 0,
        failing_notified: 0,
        created: 1,
        ...over
    };
}

export function appRow(over: Partial<AppRow> & { id: number }): AppRow {
    return {
        workspace_id: 1,
        content: JSON.stringify({ name: `App ${over.id}`, ratingCountry: 'FR' }),
        sort_order: over.id,
        created: over.id,
        ...over
    };
}

export function listingRow(
    over: Partial<ListingRow> & { id: number; app_id: number; externalId?: string; sku?: string | null }
): ListingRow {
    const { externalId, sku, ...rest } = over;
    const store = rest.store ?? 'apple';
    const id = externalId ?? (store === 'apple' ? String(1000 + over.app_id) : `com.exemple.app${over.app_id}`);
    return {
        workspace_id: 1,
        store,
        source_id: 10,
        external_ref: listingRef(keys, rest.workspace_id ?? 1, store, id),
        content: JSON.stringify({ externalId: id, storeName: null, bundleId: null, sku: sku ?? null }),
        state: null,
        history_from: null,
        synced_day: null,
        metrics_synced_at: null,
        reviews_synced_at: null,
        rating_synced_at: null,
        last_sync_at: null,
        sync_error: null,
        created: 1,
        ...rest
    };
}

export function fakeRepo(seed: Partial<Omit<FakeDb, 'calls' | 'dueCalls'>> = {}): FakeRepo {
    const db: FakeDb = {
        sources: seed.sources ?? [],
        apps: seed.apps ?? [],
        listings: seed.listings ?? [],
        daily: seed.daily ?? [],
        revenue: seed.revenue ?? [],
        countries: seed.countries ?? [],
        reviews: seed.reviews ?? [],
        shares: seed.shares ?? [],
        calls: [],
        dueCalls: []
    };
    let seq = 500;
    const among = (keys: readonly ListingKey[], appId: number, store: AppStore) =>
        keys.some(([key, keyStore]) => key === appId && keyStore === store);
    const copy = <T extends object>(row: T | undefined): T | null => (row ? { ...row } : null);
    const visible = (app: AppRow, workspaceId: number) =>
        app.workspace_id === workspaceId || db.shares.some((s) => s.appId === app.id && s.workspaceId === workspaceId);
    const dropRows = (appId: number, store: AppStore) => {
        db.daily = db.daily.filter((d) => !(d.app_id === appId && d.store === store));
        db.revenue = db.revenue.filter((r) => !(r.app_id === appId && r.store === store));
        db.countries = db.countries.filter((c) => !(c.app_id === appId && c.store === store));
        db.reviews = db.reviews.filter((r) => !(r.app_id === appId && r.store === store));
    };
    const daily = (appId: number, store: AppStore, day: number): DailyCell => {
        let cell = db.daily.find((d) => d.app_id === appId && d.store === store && d.day === day);
        if (!cell) {
            cell = {
                app_id: appId,
                store,
                day,
                downloads: null,
                updates: null,
                uninstalls: null,
                active_devices: null,
                rating_avg: null,
                rating_count: null,
                crash_rate: null,
                anr_rate: null,
                vitals_users: null
            };
            db.daily.push(cell);
        }
        return cell;
    };
    const track = <A extends unknown[], R>(name: string, fn: (...args: A) => R) => {
        return (...args: A): R => {
            db.calls.push(name);
            return fn(...args);
        };
    };

    const repo: AppStoresRepo = {
        listSources: async (ws) => db.sources.filter((s) => s.workspace_id === ws).map((s) => ({ ...s })),
        findSource: async (id, ws) => copy(db.sources.find((s) => s.id === id && s.workspace_id === ws)),
        findSourceById: async (id) => copy(db.sources.find((s) => s.id === id)),
        async createSource({ workspaceId, store, content, secretEnc, capabilities, checkedAt }) {
            const row = sourceRow({
                id: ++seq,
                workspace_id: workspaceId,
                store,
                content,
                secret_enc: secretEnc,
                capabilities,
                checked_at: checkedAt
            });
            db.sources.push(row);
            return { ...row };
        },
        async updateSource(id, ws, { content, secretEnc, capabilities, checkedAt }) {
            const row = db.sources.find((s) => s.id === id && s.workspace_id === ws);
            if (!row) return null;
            Object.assign(row, { content, capabilities, checked_at: checkedAt });
            if (secretEnc) row.secret_enc = secretEnc;
            return { ...row };
        },
        async setCapabilities(id, ws, capabilities, checkedAt) {
            const row = db.sources.find((s) => s.id === id && s.workspace_id === ws);
            if (!row) return null;
            Object.assign(row, { capabilities, checked_at: checkedAt });
            return { ...row };
        },
        async removeSource(id, ws) {
            const before = db.sources.length;
            db.sources = db.sources.filter((s) => !(s.id === id && s.workspace_id === ws));
            if (db.sources.length === before) return false;
            for (const l of db.listings) if (l.source_id === id) l.source_id = null;
            return true;
        },
        async countSourceUses(ws) {
            const out = new Map<number, number>();
            for (const l of db.listings) {
                if (l.workspace_id === ws && l.source_id !== null)
                    out.set(l.source_id, (out.get(l.source_id) ?? 0) + 1);
            }
            return out;
        },
        async recordRefusal(id, { at, error }) {
            const row = db.sources.find((s) => s.id === id);
            if (!row) return null;
            row.failing_count += 1;
            row.failing_since ??= at;
            row.failing_error = error;
            return { count: row.failing_count, notified: row.failing_notified === 1 };
        },
        async markSourceNotified(id) {
            const row = db.sources.find((s) => s.id === id);
            if (row) row.failing_notified = 1;
        },
        async clearSourceFailure(id) {
            const row = db.sources.find((s) => s.id === id);
            if (row)
                Object.assign(row, { failing_count: 0, failing_since: null, failing_error: null, failing_notified: 0 });
        },
        listAppIdsOfSource: async (sourceId) =>
            [...new Set(db.listings.filter((l) => l.source_id === sourceId).map((l) => l.app_id))].sort(
                (a, b) => a - b
            ),

        listVisibleApps: async (ws) =>
            db.apps
                .filter((a) => visible(a, ws))
                .sort(
                    (a, b) =>
                        Number(a.workspace_id !== ws) - Number(b.workspace_id !== ws) || a.sort_order - b.sort_order
                )
                .map((a) => ({ ...a })),
        findApp: async (id, ws) => copy(db.apps.find((a) => a.id === id && a.workspace_id === ws)),
        findVisibleApp: async (id, ws) => copy(db.apps.find((a) => a.id === id && visible(a, ws))),
        listAppsByIds: async (ids) => db.apps.filter((a) => ids.includes(a.id)).map((a) => ({ ...a })),
        countAppsInWorkspaces: async (ids) => db.apps.filter((a) => ids.includes(a.workspace_id)).length,
        listStockApps: async (ids) =>
            db.apps
                .filter((a) => ids.includes(a.workspace_id))
                .sort((a, b) => a.created - b.created || a.id - b.id)
                .map((a) => ({ id: String(a.id), workspaceId: a.workspace_id })),
        async createApp({ workspaceId, content }) {
            const row = appRow({ id: ++seq, workspace_id: workspaceId, content, created: seq });
            db.apps.push(row);
            return { ...row };
        },
        async updateAppContent(id, ws, content) {
            const row = db.apps.find((a) => a.id === id && a.workspace_id === ws);
            if (!row) return false;
            row.content = content;
            return true;
        },
        async deleteApp(id, ws) {
            const before = db.apps.length;
            db.apps = db.apps.filter((a) => !(a.id === id && a.workspace_id === ws));
            if (db.apps.length === before) return false;
            db.listings = db.listings.filter((l) => l.app_id !== id);
            db.daily = db.daily.filter((d) => d.app_id !== id);
            db.revenue = db.revenue.filter((r) => r.app_id !== id);
            db.countries = db.countries.filter((c) => c.app_id !== id);
            db.reviews = db.reviews.filter((r) => r.app_id !== id);
            return true;
        },

        listListingsOfApps: async (ids) => db.listings.filter((l) => ids.includes(l.app_id)).map((l) => ({ ...l })),
        findListingByRef: async (ws, ref) =>
            copy(db.listings.find((l) => l.workspace_id === ws && l.external_ref === ref)),
        listListingRefs: async (ws) => db.listings.filter((l) => l.workspace_id === ws).map((l) => l.external_ref),
        async createListing({ appId, workspaceId, store, sourceId, externalRef: ref, content }) {
            if (
                db.listings.some(
                    (l) =>
                        (l.app_id === appId && l.store === store) ||
                        (l.workspace_id === workspaceId && l.external_ref === ref)
                )
            ) {
                throw Object.assign(new Error('Duplicate entry'), { code: 'ER_DUP_ENTRY' });
            }
            dropRows(appId, store);
            db.listings.push(
                listingRow({
                    id: ++seq,
                    app_id: appId,
                    workspace_id: workspaceId,
                    store,
                    source_id: sourceId,
                    external_ref: ref,
                    content
                })
            );
        },
        async setListingSource(id, sourceId) {
            const row = db.listings.find((l) => l.id === id);
            if (row) Object.assign(row, { source_id: sourceId, sync_error: null });
        },
        async deleteListing(appId, store) {
            db.listings = db.listings.filter((l) => !(l.app_id === appId && l.store === store));
            dropRows(appId, store);
        },
        async resetRating(appId) {
            for (const l of db.listings) if (l.app_id === appId && l.store === 'apple') l.rating_synced_at = null;
        },
        listListingsOfSource: async (sourceId) =>
            db.listings.filter((l) => l.source_id === sourceId).map((l) => ({ ...l })),
        async listDue(input) {
            db.dueCalls.push(input);
            const due = (column: number | null, before: number) => column === null || column <= before;
            return db.listings
                .filter(
                    (l) =>
                        l.source_id !== null &&
                        (due(l.metrics_synced_at, input.metricsBefore) ||
                            due(l.reviews_synced_at, input.reviewsBefore) ||
                            (l.store === 'apple' && due(l.rating_synced_at, input.ratingBefore))) &&
                        !input.pausedAppIds.includes(l.app_id) &&
                        !input.skipSourceIds.includes(l.source_id)
                )
                .sort(
                    (a, b) =>
                        Number(a.last_sync_at !== null) - Number(b.last_sync_at !== null) ||
                        (a.last_sync_at ?? 0) - (b.last_sync_at ?? 0) ||
                        a.id - b.id
                )
                .slice(0, input.limit)
                .map((l) => ({ id: l.id, app_id: l.app_id, source_id: l.source_id as number }));
        },
        async saveListing(id, sync) {
            const row = db.listings.find((l) => l.id === id);
            if (!row) return;
            Object.assign(row, {
                content: sync.content ?? row.content,
                state: sync.state,
                synced_day: sync.syncedDay,
                history_from: sync.historyFrom,
                metrics_synced_at: sync.metricsSyncedAt ?? row.metrics_synced_at,
                reviews_synced_at: sync.reviewsSyncedAt ?? row.reviews_synced_at,
                rating_synced_at: sync.ratingSyncedAt ?? row.rating_synced_at,
                last_sync_at: sync.lastSyncAt,
                sync_error: sync.syncError
            });
        },
        async saveCoverage(id, syncedDay, historyFrom) {
            const row = db.listings.find((l) => l.id === id);
            if (row) Object.assign(row, { synced_day: syncedDay, history_from: historyFrom });
        },
        async clearMetricsSync(id) {
            const row = db.listings.find((l) => l.id === id);
            if (row) row.metrics_synced_at = null;
        },

        async writeDownloads(appId, store, rows) {
            for (const r of rows) {
                Object.assign(daily(appId, store, r.day), {
                    downloads: r.downloads,
                    updates: r.updates,
                    uninstalls: r.uninstalls,
                    active_devices: r.activeDevices
                });
            }
        },
        async writeRatings(appId, store, rows) {
            for (const r of rows)
                Object.assign(daily(appId, store, r.day), { rating_avg: r.rating, rating_count: r.count });
        },
        async writeVitals(appId, store, rows) {
            for (const r of rows) {
                Object.assign(daily(appId, store, r.day), {
                    crash_rate: r.crashRate,
                    anr_rate: r.anrRate,
                    vitals_users: r.users
                });
            }
        },
        async writeCountries(appId, store, rows) {
            for (const r of rows) {
                const same = (c: CountryCell) =>
                    c.app_id === appId && c.store === store && c.day === r.day && c.country === r.country;
                db.countries = [...db.countries.filter((c) => !same(c)), { app_id: appId, store, ...r }];
            }
        },
        async replaceRevenue(appId, store, fromDay, toDay, rows) {
            db.revenue = db.revenue.filter(
                (r) => !(r.app_id === appId && r.store === store && r.day >= fromDay && r.day <= toDay)
            );
            for (const r of rows) db.revenue.push({ app_id: appId, store, ...r });
        },
        dailyRows: async (appId, from, to) =>
            db.daily
                .filter((d) => d.app_id === appId && d.day >= from && d.day <= to)
                .sort((a, b) => a.day - b.day)
                .map((d) => ({
                    store: d.store,
                    day: d.day,
                    downloads: d.downloads,
                    rating_avg: d.rating_avg,
                    crash_rate: d.crash_rate,
                    anr_rate: d.anr_rate,
                    vitals_users: d.vitals_users
                })),
        revenueRows: async (keys, from, to) =>
            db.revenue
                .filter((r) => among(keys, r.app_id, r.store) && r.day >= from && r.day <= to)
                .map((r) => ({
                    app_id: r.app_id,
                    store: r.store,
                    day: r.day,
                    currency: r.currency,
                    amount: r.amount,
                    units: r.units
                })),
        async countryTotals(keys, from, to) {
            const totals = new Map<string, number>();
            for (const c of db.countries) {
                if (!among(keys, c.app_id, c.store) || c.day < from || c.day > to) continue;
                totals.set(c.country, (totals.get(c.country) ?? 0) + c.downloads);
            }
            return [...totals]
                .map(([country, downloads]) => ({ country, downloads }))
                .sort((a, b) => b.downloads - a.downloads || a.country.localeCompare(b.country));
        },
        vitalsOf: async (ids, from, to) =>
            db.daily
                .filter(
                    (d) =>
                        d.store === 'google' &&
                        ids.includes(d.app_id) &&
                        d.day >= from &&
                        d.day <= to &&
                        (d.crash_rate !== null || d.anr_rate !== null)
                )
                .map((d) => ({
                    app_id: d.app_id,
                    day: d.day,
                    crash_rate: d.crash_rate,
                    anr_rate: d.anr_rate,
                    vitals_users: d.vitals_users
                })),
        async purgeCountriesBefore(day) {
            const before = db.countries.length;
            db.countries = db.countries.filter((c) => c.day >= day);
            return before - db.countries.length;
        },
        downloadsOf: async (ids, from, to) =>
            db.daily
                .filter((d) => ids.includes(d.app_id) && d.day >= from && d.day <= to)
                .map((d) => ({ app_id: d.app_id, store: d.store, day: d.day, downloads: d.downloads })),

        findReview: async (id) => copy(db.reviews.find((r) => r.id === id)),
        async listReviews(appId, filter, limit) {
            return db.reviews
                .filter(
                    (r) =>
                        r.app_id === appId &&
                        (!filter.store || r.store === filter.store) &&
                        (!filter.rating || r.rating === filter.rating) &&
                        (!filter.unanswered || r.replied_at === null) &&
                        (!filter.before ||
                            r.created_at < filter.before.createdAt ||
                            (r.created_at === filter.before.createdAt && r.id < filter.before.id))
                )
                .sort((a, b) => b.created_at - a.created_at || b.id - a.id)
                .slice(0, limit)
                .map((r) => ({ ...r }));
        },
        async reviewCounts(keys, from, split, to) {
            const out = new Map<number, { rating: number; previous: number; current: number }>();
            for (const r of db.reviews) {
                if (!among(keys, r.app_id, r.store)) continue;
                if (r.created_at < from || r.created_at >= to) continue;
                const entry = out.get(r.rating) ?? { rating: r.rating, previous: 0, current: 0 };
                if (r.created_at < split) entry.previous += 1;
                else entry.current += 1;
                out.set(r.rating, entry);
            }
            return [...out.values()];
        },
        async unansweredReviews(keys, from, to, limit) {
            const open = db.reviews
                .filter(
                    (r) =>
                        among(keys, r.app_id, r.store) &&
                        r.replied_at === null &&
                        r.created_at >= from &&
                        r.created_at < to
                )
                .sort((a, b) => a.rating - b.rating || b.created_at - a.created_at || b.id - a.id);
            return { total: open.length, rows: open.slice(0, limit).map((r) => ({ ...r })) };
        },
        reviewsByRefs: async (appId, store, refs) =>
            db.reviews
                .filter((r) => r.app_id === appId && r.store === store && refs.includes(r.external_ref))
                .map((r) => ({ ...r })),
        async insertReview({ appId, store, externalRef: ref, rating, createdAt, repliedAt, content }) {
            if (db.reviews.some((r) => r.app_id === appId && r.store === store && r.external_ref === ref)) return false;
            db.reviews.push({
                id: ++seq,
                app_id: appId,
                store,
                external_ref: ref,
                rating,
                created_at: createdAt,
                replied_at: repliedAt,
                content
            });
            return true;
        },
        async updateReview(id, { rating, repliedAt, content }) {
            const row = db.reviews.find((r) => r.id === id);
            if (row) Object.assign(row, { rating, replied_at: repliedAt, content });
        },
        repliedSince: async (appId, store, since) =>
            db.reviews
                .filter(
                    (r) => r.app_id === appId && r.store === store && r.replied_at !== null && r.replied_at >= since
                )
                .map((r) => ({ ...r })),
        async purgeReviewsBefore(cutoff) {
            const before = db.reviews.length;
            db.reviews = db.reviews.filter((r) => r.created_at >= cutoff);
            return before - db.reviews.length;
        },
        async overflowingReviews(max) {
            const counts = new Map<string, number>();
            for (const r of db.reviews)
                counts.set(`${r.app_id}:${r.store}`, (counts.get(`${r.app_id}:${r.store}`) ?? 0) + 1);
            return [...counts]
                .filter(([, n]) => n > max)
                .map(([key]) => {
                    const [app, store] = key.split(':');
                    return { app_id: Number(app), store: store as AppStore };
                });
        },
        async trimReviews(appId, store, keep) {
            const mine = db.reviews
                .filter((r) => r.app_id === appId && r.store === store)
                .sort((a, b) => b.created_at - a.created_at || b.id - a.id);
            const drop = new Set(mine.slice(keep).map((r) => r.id));
            db.reviews = db.reviews.filter((r) => !drop.has(r.id));
            return drop.size;
        }
    };

    const tracked = Object.fromEntries(
        Object.entries(repo).map(([name, fn]) => [name, track(name, fn as (...args: unknown[]) => unknown)])
    ) as unknown as AppStoresRepo;
    return Object.assign(tracked, { db });
}
