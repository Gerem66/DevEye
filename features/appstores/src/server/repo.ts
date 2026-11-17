import type { AppStore } from '../contracts/domain';
import type { SdkQueryable, SdkStockItem } from '@deveye/types/sdk/server';

/**
 * Les tables du module. Rien n'y est chiffré ni déchiffré : les handlers et le
 * service passent des cellules déjà scellées. Les jours se comptent depuis
 * 1970 en UTC, les instants en secondes epoch.
 */

export interface SourceRow {
    id: number;
    workspace_id: number;
    store: AppStore;
    content: string;
    secret_enc: string;
    capabilities: string;
    checked_at: number | null;
    failing_since: number | null;
    failing_error: string | null;
    failing_count: number;
    failing_notified: number;
    created: number;
}

export interface AppRow {
    id: number;
    workspace_id: number;
    content: string;
    sort_order: number;
    created: number;
}

export interface ListingRow {
    id: number;
    app_id: number;
    workspace_id: number;
    store: AppStore;
    source_id: number | null;
    external_ref: string;
    content: string;
    state: string | null;
    history_from: number | null;
    synced_day: number | null;
    metrics_synced_at: number | null;
    reviews_synced_at: number | null;
    rating_synced_at: number | null;
    last_sync_at: number | null;
    sync_error: string | null;
    created: number;
}

export interface DailyRow {
    store: AppStore;
    day: number;
    downloads: number | null;
    rating_avg: number | null;
    crash_rate: number | null;
    anr_rate: number | null;
    vitals_users: number | null;
}

export interface RevenueRow {
    store: AppStore;
    day: number;
    currency: string;
    amount: number;
    units: number;
}

export interface ReviewRow {
    id: number;
    app_id: number;
    store: AppStore;
    external_ref: string;
    rating: number;
    created_at: number;
    replied_at: number | null;
    content: string;
}

export interface DownloadsInput {
    day: number;
    downloads: number | null;
    updates: number | null;
    uninstalls: number | null;
    activeDevices: number | null;
}

export interface VitalsInput {
    day: number;
    crashRate: number | null;
    anrRate: number | null;
    users: number | null;
}

/** Les premiers téléchargements d'un jour dans un pays. */
export interface CountryInput {
    day: number;
    /** Le code ISO à deux lettres, en capitales. */
    country: string;
    downloads: number;
}

export interface RevenueInput {
    day: number;
    currency: string;
    amount: number;
    units: number;
}

export interface ReviewFilter {
    store?: AppStore;
    rating?: number;
    unanswered?: boolean;
    before?: { createdAt: number; id: number };
}

/** Ce que la synchronisation écrit d'une fiche ; un instant `null` garde la valeur en place. */
export interface ListingSync {
    content: string | null;
    state: string;
    syncedDay: number | null;
    historyFrom: number | null;
    metricsSyncedAt: number | null;
    reviewsSyncedAt: number | null;
    ratingSyncedAt: number | null;
    lastSyncAt: number;
    syncError: string | null;
}

/** Les lignes d'une écriture groupée : au-delà, une requête de plus. */
const BULK = 500;

export interface AppStoresRepo {
    listSources(workspaceId: number): Promise<SourceRow[]>;
    findSource(id: number, workspaceId: number): Promise<SourceRow | null>;
    /** Le service seul : une source, quel que soit son espace. */
    findSourceById(id: number): Promise<SourceRow | null>;
    createSource(input: {
        workspaceId: number;
        store: AppStore;
        content: string;
        secretEnc: string;
        capabilities: string;
        checkedAt: number;
    }): Promise<SourceRow>;
    /** `secretEnc` absent garde le secret en place. */
    updateSource(
        id: number,
        workspaceId: number,
        input: { content: string; secretEnc?: string; capabilities: string; checkedAt: number }
    ): Promise<SourceRow | null>;
    setCapabilities(
        id: number,
        workspaceId: number,
        capabilities: string,
        checkedAt: number
    ): Promise<SourceRow | null>;
    /** Les fiches qui s'en servaient restent, sans source. */
    removeSource(id: number, workspaceId: number): Promise<boolean>;
    /** Combien de fiches de store s'appuient sur chaque source de l'espace. */
    countSourceUses(workspaceId: number): Promise<Map<number, number>>;
    /** Un refus de plus dans la série ; rend le compte et si la perte a déjà été annoncée. */
    recordRefusal(
        id: number,
        input: { at: number; error: string }
    ): Promise<{ count: number; notified: boolean } | null>;
    markSourceNotified(id: number): Promise<void>;
    clearSourceFailure(id: number): Promise<void>;
    /** Les apps dont une fiche s'appuie sur cette source. */
    listAppIdsOfSource(sourceId: number): Promise<number[]>;

    /** Les apps de l'espace, puis celles qui y sont projetées. */
    listVisibleApps(workspaceId: number): Promise<AppRow[]>;
    findApp(id: number, workspaceId: number): Promise<AppRow | null>;
    /** Comme `findApp`, mais accepte aussi une app projetée vers cet espace. */
    findVisibleApp(id: number, workspaceId: number): Promise<AppRow | null>;
    listAppsByIds(ids: readonly number[]): Promise<AppRow[]>;
    countAppsInWorkspaces(workspaceIds: readonly number[]): Promise<number>;
    /** Ce que compte `countAppsInWorkspaces`, du plus ancien au plus récent : le stock du quota `apps`. */
    listStockApps(workspaceIds: readonly number[]): Promise<SdkStockItem[]>;
    createApp(input: { workspaceId: number; content: string }): Promise<AppRow>;
    updateAppContent(id: number, workspaceId: number, content: string): Promise<boolean>;
    deleteApp(id: number, workspaceId: number): Promise<boolean>;

    listListingsOfApps(appIds: readonly number[]): Promise<ListingRow[]>;
    findListingByRef(workspaceId: number, externalRef: string): Promise<ListingRow | null>;
    listListingRefs(workspaceId: number): Promise<string[]>;
    /** Une fiche neuve, débarrassée de ce qu'une fiche retirée du même store aurait laissé. */
    createListing(input: {
        appId: number;
        workspaceId: number;
        store: AppStore;
        sourceId: number | null;
        externalRef: string;
        content: string;
    }): Promise<void>;
    setListingSource(id: number, sourceId: number | null): Promise<void>;
    /** Retire la fiche d'un store, et ses chiffres, revenus et avis. */
    deleteListing(appId: number, store: AppStore): Promise<void>;
    /** La note Apple sera relue au prochain passage (pays de référence changé). */
    resetRating(appId: number): Promise<void>;
    listListingsOfSource(sourceId: number): Promise<ListingRow[]>;
    /**
     * Les fiches qu'un passage attend, jamais synchronisées d'abord. Les apps
     * en pause et les sources occupées ou en repli sont écartées dans le SQL :
     * après le `LIMIT`, elles occuperaient la fenêtre sans jamais avancer.
     */
    listDue(input: {
        metricsBefore: number;
        reviewsBefore: number;
        ratingBefore: number;
        pausedAppIds: readonly number[];
        skipSourceIds: readonly number[];
        limit: number;
    }): Promise<{ id: number; app_id: number; source_id: number }[]>;
    saveListing(id: number, sync: ListingSync): Promise<void>;
    saveCoverage(id: number, syncedDay: number | null, historyFrom: number | null): Promise<void>;
    /** Les chiffres de la fiche redeviennent dus. */
    clearMetricsSync(id: number): Promise<void>;

    writeDownloads(appId: number, store: AppStore, rows: readonly DownloadsInput[]): Promise<void>;
    writeRatings(
        appId: number,
        store: AppStore,
        rows: readonly { day: number; rating: number; count: number | null }[]
    ): Promise<void>;
    writeVitals(appId: number, store: AppStore, rows: readonly VitalsInput[]): Promise<void>;
    writeCountries(appId: number, store: AppStore, rows: readonly CountryInput[]): Promise<void>;
    /** Les revenus de `fromDay` à `toDay` sont remplacés par `rows`. */
    replaceRevenue(
        appId: number,
        store: AppStore,
        fromDay: number,
        toDay: number,
        rows: readonly RevenueInput[]
    ): Promise<void>;
    dailyRows(appId: number, fromDay: number, toDay: number): Promise<DailyRow[]>;
    revenueRows(appId: number, fromDay: number, toDay: number): Promise<RevenueRow[]>;
    /** Les téléchargements de la période par pays, d'un store ou des deux (`null`), les plus nombreux d'abord. */
    countryTotals(
        appId: number,
        store: AppStore | null,
        fromDay: number,
        toDay: number
    ): Promise<{ country: string; downloads: number }[]>;
    purgeCountriesBefore(day: number): Promise<number>;
    downloadsOf(
        appIds: readonly number[],
        fromDay: number,
        toDay: number
    ): Promise<{ app_id: number; store: AppStore; day: number; downloads: number | null }[]>;

    findReview(id: number): Promise<ReviewRow | null>;
    listReviews(appId: number, filter: ReviewFilter, limit: number): Promise<ReviewRow[]>;
    /** Les avis reçus par note : `[from, split[` et `[split, to[`, d'un store ou de tous (`null`). */
    reviewCounts(
        appId: number,
        store: AppStore | null,
        from: number,
        split: number,
        to: number
    ): Promise<{ rating: number; previous: number; current: number }[]>;
    reviewsByRefs(appId: number, store: AppStore, refs: readonly string[]): Promise<ReviewRow[]>;
    /** `false` quand l'avis était déjà là. */
    insertReview(input: {
        appId: number;
        store: AppStore;
        externalRef: string;
        rating: number;
        createdAt: number;
        repliedAt: number | null;
        content: string;
    }): Promise<boolean>;
    updateReview(id: number, input: { rating: number; repliedAt: number | null; content: string }): Promise<void>;
    /** Les avis répondus depuis `since` : ceux dont la réponse attend peut-être encore Apple. */
    repliedSince(appId: number, store: AppStore, since: number): Promise<ReviewRow[]>;
    purgeReviewsBefore(cutoff: number): Promise<number>;
    /** Les couples app et store qui gardent plus de `max` avis. */
    overflowingReviews(max: number): Promise<{ app_id: number; store: AppStore }[]>;
    /** Ne garde que les `keep` avis les plus récents d'une app sur un store. */
    trimReviews(appId: number, store: AppStore, keep: number): Promise<number>;
}

export function createRepo(q: SdkQueryable): AppStoresRepo {
    async function findSource(id: number, workspaceId: number): Promise<SourceRow | null> {
        const rows = await q.query<SourceRow>('SELECT * FROM ft_appstores_sources WHERE id = ? AND workspace_id = ?', [
            id,
            workspaceId
        ]);
        return rows[0] ?? null;
    }

    async function findSourceById(id: number): Promise<SourceRow | null> {
        const rows = await q.query<SourceRow>('SELECT * FROM ft_appstores_sources WHERE id = ?', [id]);
        return rows[0] ?? null;
    }

    async function findApp(id: number, workspaceId: number): Promise<AppRow | null> {
        const rows = await q.query<AppRow>('SELECT * FROM ft_appstores_apps WHERE id = ? AND workspace_id = ?', [
            id,
            workspaceId
        ]);
        return rows[0] ?? null;
    }

    async function deleteAppRows(appId: number, store: AppStore): Promise<void> {
        await q.execute('DELETE FROM ft_appstores_daily WHERE app_id = ? AND store = ?', [appId, store]);
        await q.execute('DELETE FROM ft_appstores_revenue WHERE app_id = ? AND store = ?', [appId, store]);
        await q.execute('DELETE FROM ft_appstores_countries WHERE app_id = ? AND store = ?', [appId, store]);
        await q.execute('DELETE FROM ft_appstores_reviews WHERE app_id = ? AND store = ?', [appId, store]);
    }

    return {
        async listSources(workspaceId) {
            return q.query<SourceRow>('SELECT * FROM ft_appstores_sources WHERE workspace_id = ? ORDER BY id ASC', [
                workspaceId
            ]);
        },
        findSource,
        findSourceById,
        async createSource({ workspaceId, store, content, secretEnc, capabilities, checkedAt }) {
            const res = await q.execute(
                `INSERT INTO ft_appstores_sources (workspace_id, store, content, secret_enc, capabilities, checked_at)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [workspaceId, store, content, secretEnc, capabilities, checkedAt]
            );
            return (await findSourceById(res.insertId)) as SourceRow;
        },
        async updateSource(id, workspaceId, { content, secretEnc, capabilities, checkedAt }) {
            const res = secretEnc
                ? await q.execute(
                      `UPDATE ft_appstores_sources SET content = ?, secret_enc = ?, capabilities = ?, checked_at = ?
                        WHERE id = ? AND workspace_id = ?`,
                      [content, secretEnc, capabilities, checkedAt, id, workspaceId]
                  )
                : await q.execute(
                      `UPDATE ft_appstores_sources SET content = ?, capabilities = ?, checked_at = ?
                        WHERE id = ? AND workspace_id = ?`,
                      [content, capabilities, checkedAt, id, workspaceId]
                  );
            return res.affectedRows === 0 ? null : findSource(id, workspaceId);
        },
        async setCapabilities(id, workspaceId, capabilities, checkedAt) {
            const res = await q.execute(
                'UPDATE ft_appstores_sources SET capabilities = ?, checked_at = ? WHERE id = ? AND workspace_id = ?',
                [capabilities, checkedAt, id, workspaceId]
            );
            return res.affectedRows === 0 ? null : findSource(id, workspaceId);
        },
        async removeSource(id, workspaceId) {
            await q.execute(
                'UPDATE ft_appstores_listings SET source_id = NULL WHERE source_id = ? AND workspace_id = ?',
                [id, workspaceId]
            );
            const res = await q.execute('DELETE FROM ft_appstores_sources WHERE id = ? AND workspace_id = ?', [
                id,
                workspaceId
            ]);
            return res.affectedRows > 0;
        },
        async countSourceUses(workspaceId) {
            const rows = await q.query<{ source_id: number; uses: number }>(
                `SELECT source_id, COUNT(*) AS uses FROM ft_appstores_listings
                  WHERE workspace_id = ? AND source_id IS NOT NULL
                  GROUP BY source_id`,
                [workspaceId]
            );
            return new Map(rows.map((row) => [Number(row.source_id), Number(row.uses)]));
        },
        async recordRefusal(id, { at, error }) {
            await q.execute(
                `UPDATE ft_appstores_sources
                    SET failing_count = failing_count + 1, failing_since = COALESCE(failing_since, ?), failing_error = ?
                  WHERE id = ?`,
                [at, error, id]
            );
            const row = await findSourceById(id);
            return row ? { count: Number(row.failing_count), notified: Number(row.failing_notified) === 1 } : null;
        },
        async markSourceNotified(id) {
            await q.execute('UPDATE ft_appstores_sources SET failing_notified = 1 WHERE id = ?', [id]);
        },
        async clearSourceFailure(id) {
            await q.execute(
                `UPDATE ft_appstores_sources
                    SET failing_count = 0, failing_since = NULL, failing_error = NULL, failing_notified = 0
                  WHERE id = ?`,
                [id]
            );
        },
        async listAppIdsOfSource(sourceId) {
            const rows = await q.query<{ app_id: number }>(
                'SELECT DISTINCT app_id FROM ft_appstores_listings WHERE source_id = ? ORDER BY app_id ASC',
                [sourceId]
            );
            return rows.map((row) => Number(row.app_id));
        },

        async listVisibleApps(workspaceId) {
            // `sort_order` appartient à l'espace d'origine : une app projetée se
            // range après celles d'ici.
            return q.query<AppRow>(
                `SELECT a.*, 0 AS projected FROM ft_appstores_apps a WHERE a.workspace_id = ?
                 UNION ALL
                 SELECT a.*, 1 AS projected FROM ft_appstores_apps a
                   JOIN item_shares sh
                     ON sh.feature = 'appstores' AND sh.item_id = a.id AND sh.home_workspace_id = a.workspace_id
                  WHERE sh.workspace_id = ?
                  ORDER BY projected ASC, sort_order ASC, id ASC`,
                [workspaceId, workspaceId]
            );
        },
        findApp,
        async findVisibleApp(id, workspaceId) {
            const rows = await q.query<AppRow>(
                `SELECT a.* FROM ft_appstores_apps a
                  WHERE a.id = ?
                    AND (a.workspace_id = ?
                         OR EXISTS (SELECT 1 FROM item_shares sh
                                     WHERE sh.feature = 'appstores' AND sh.item_id = a.id
                                       AND sh.home_workspace_id = a.workspace_id
                                       AND sh.workspace_id = ?))`,
                [id, workspaceId, workspaceId]
            );
            return rows[0] ?? null;
        },
        async listAppsByIds(ids) {
            if (ids.length === 0) return [];
            return q.query<AppRow>('SELECT * FROM ft_appstores_apps WHERE id IN (?)', [[...ids]]);
        },
        async countAppsInWorkspaces(workspaceIds) {
            if (workspaceIds.length === 0) return 0;
            const rows = await q.query<{ total: number }>(
                'SELECT COUNT(*) AS total FROM ft_appstores_apps WHERE workspace_id IN (?)',
                [[...workspaceIds]]
            );
            return Number(rows[0]?.total ?? 0);
        },
        async listStockApps(workspaceIds) {
            if (workspaceIds.length === 0) return [];
            const rows = await q.query<{ id: number; workspace_id: number }>(
                'SELECT id, workspace_id FROM ft_appstores_apps WHERE workspace_id IN (?) ORDER BY created ASC, id ASC',
                [[...workspaceIds]]
            );
            return rows.map((row) => ({ id: String(row.id), workspaceId: Number(row.workspace_id) }));
        },
        async createApp({ workspaceId, content }) {
            // Une app neuve arrive en fin de liste : l'ordre appartient à l'espace.
            const next = await q.query<{ next: number }>(
                'SELECT COALESCE(MAX(sort_order) + 1, 0) AS next FROM ft_appstores_apps WHERE workspace_id = ?',
                [workspaceId]
            );
            const res = await q.execute(
                'INSERT INTO ft_appstores_apps (workspace_id, content, sort_order) VALUES (?, ?, ?)',
                [workspaceId, content, Number(next[0]?.next ?? 0)]
            );
            return (await findApp(res.insertId, workspaceId)) as AppRow;
        },
        async updateAppContent(id, workspaceId, content) {
            const res = await q.execute('UPDATE ft_appstores_apps SET content = ? WHERE id = ? AND workspace_id = ?', [
                content,
                id,
                workspaceId
            ]);
            return res.affectedRows > 0;
        },
        async deleteApp(id, workspaceId) {
            // Fiches, chiffres, revenus et avis partent en CASCADE.
            const res = await q.execute('DELETE FROM ft_appstores_apps WHERE id = ? AND workspace_id = ?', [
                id,
                workspaceId
            ]);
            return res.affectedRows > 0;
        },

        async listListingsOfApps(appIds) {
            if (appIds.length === 0) return [];
            return q.query<ListingRow>('SELECT * FROM ft_appstores_listings WHERE app_id IN (?) ORDER BY id ASC', [
                [...appIds]
            ]);
        },
        async findListingByRef(workspaceId, externalRef) {
            const rows = await q.query<ListingRow>(
                'SELECT * FROM ft_appstores_listings WHERE workspace_id = ? AND external_ref = ?',
                [workspaceId, externalRef]
            );
            return rows[0] ?? null;
        },
        async listListingRefs(workspaceId) {
            const rows = await q.query<{ external_ref: string }>(
                'SELECT external_ref FROM ft_appstores_listings WHERE workspace_id = ?',
                [workspaceId]
            );
            return rows.map((row) => row.external_ref);
        },
        async createListing({ appId, workspaceId, store, sourceId, externalRef, content }) {
            await deleteAppRows(appId, store);
            await q.execute(
                `INSERT INTO ft_appstores_listings (app_id, workspace_id, store, source_id, external_ref, content)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [appId, workspaceId, store, sourceId, externalRef, content]
            );
        },
        async setListingSource(id, sourceId) {
            await q.execute('UPDATE ft_appstores_listings SET source_id = ?, sync_error = NULL WHERE id = ?', [
                sourceId,
                id
            ]);
        },
        async deleteListing(appId, store) {
            await q.execute('DELETE FROM ft_appstores_listings WHERE app_id = ? AND store = ?', [appId, store]);
            await deleteAppRows(appId, store);
        },
        async resetRating(appId) {
            await q.execute(
                "UPDATE ft_appstores_listings SET rating_synced_at = NULL WHERE app_id = ? AND store = 'apple'",
                [appId]
            );
        },
        async listListingsOfSource(sourceId) {
            return q.query<ListingRow>('SELECT * FROM ft_appstores_listings WHERE source_id = ? ORDER BY id ASC', [
                sourceId
            ]);
        },
        async listDue({ metricsBefore, reviewsBefore, ratingBefore, pausedAppIds, skipSourceIds, limit }) {
            // `NOT IN ()` n'est pas du SQL : chaque clause n'existe qu'avec sa liste.
            const paused = pausedAppIds.length > 0;
            const skip = skipSourceIds.length > 0;
            return q.query<{ id: number; app_id: number; source_id: number }>(
                `SELECT id, app_id, source_id FROM ft_appstores_listings
                  WHERE source_id IS NOT NULL
                    AND (metrics_synced_at IS NULL OR metrics_synced_at <= ?
                         OR reviews_synced_at IS NULL OR reviews_synced_at <= ?
                         OR (store = 'apple' AND (rating_synced_at IS NULL OR rating_synced_at <= ?)))
                    ${paused ? 'AND app_id NOT IN (?)' : ''}
                    ${skip ? 'AND source_id NOT IN (?)' : ''}
                  ORDER BY last_sync_at IS NOT NULL, last_sync_at ASC, id ASC
                  LIMIT ?`,
                [
                    metricsBefore,
                    reviewsBefore,
                    ratingBefore,
                    ...(paused ? [[...pausedAppIds]] : []),
                    ...(skip ? [[...skipSourceIds]] : []),
                    limit
                ]
            );
        },
        async saveListing(id, sync) {
            await q.execute(
                `UPDATE ft_appstores_listings
                    SET content = COALESCE(?, content), state = ?, synced_day = ?, history_from = ?,
                        metrics_synced_at = COALESCE(?, metrics_synced_at),
                        reviews_synced_at = COALESCE(?, reviews_synced_at),
                        rating_synced_at = COALESCE(?, rating_synced_at),
                        last_sync_at = ?, sync_error = ?
                  WHERE id = ?`,
                [
                    sync.content,
                    sync.state,
                    sync.syncedDay,
                    sync.historyFrom,
                    sync.metricsSyncedAt,
                    sync.reviewsSyncedAt,
                    sync.ratingSyncedAt,
                    sync.lastSyncAt,
                    sync.syncError,
                    id
                ]
            );
        },
        async saveCoverage(id, syncedDay, historyFrom) {
            await q.execute('UPDATE ft_appstores_listings SET synced_day = ?, history_from = ? WHERE id = ?', [
                syncedDay,
                historyFrom,
                id
            ]);
        },

        async clearMetricsSync(id) {
            await q.execute('UPDATE ft_appstores_listings SET metrics_synced_at = NULL WHERE id = ?', [id]);
        },

        async writeDownloads(appId, store, rows) {
            for (let at = 0; at < rows.length; at += BULK) {
                const chunk = rows
                    .slice(at, at + BULK)
                    .map((r) => [appId, store, r.day, r.downloads, r.updates, r.uninstalls, r.activeDevices]);
                await q.execute(
                    `INSERT INTO ft_appstores_daily (app_id, store, day, downloads, updates, uninstalls, active_devices)
                     VALUES ?
                     ON DUPLICATE KEY UPDATE downloads = VALUES(downloads), updates = VALUES(updates),
                         uninstalls = VALUES(uninstalls), active_devices = VALUES(active_devices)`,
                    [chunk]
                );
            }
        },
        async writeRatings(appId, store, rows) {
            for (let at = 0; at < rows.length; at += BULK) {
                const chunk = rows.slice(at, at + BULK).map((r) => [appId, store, r.day, r.rating, r.count]);
                await q.execute(
                    `INSERT INTO ft_appstores_daily (app_id, store, day, rating_avg, rating_count)
                     VALUES ?
                     ON DUPLICATE KEY UPDATE rating_avg = VALUES(rating_avg), rating_count = VALUES(rating_count)`,
                    [chunk]
                );
            }
        },
        async writeVitals(appId, store, rows) {
            for (let at = 0; at < rows.length; at += BULK) {
                const chunk = rows
                    .slice(at, at + BULK)
                    .map((r) => [appId, store, r.day, r.crashRate, r.anrRate, r.users]);
                await q.execute(
                    `INSERT INTO ft_appstores_daily (app_id, store, day, crash_rate, anr_rate, vitals_users)
                     VALUES ?
                     ON DUPLICATE KEY UPDATE crash_rate = VALUES(crash_rate), anr_rate = VALUES(anr_rate),
                         vitals_users = VALUES(vitals_users)`,
                    [chunk]
                );
            }
        },
        async writeCountries(appId, store, rows) {
            for (let at = 0; at < rows.length; at += BULK) {
                const chunk = rows.slice(at, at + BULK).map((r) => [appId, store, r.day, r.country, r.downloads]);
                await q.execute(
                    `INSERT INTO ft_appstores_countries (app_id, store, day, country, downloads)
                     VALUES ?
                     ON DUPLICATE KEY UPDATE downloads = VALUES(downloads)`,
                    [chunk]
                );
            }
        },
        async replaceRevenue(appId, store, fromDay, toDay, rows) {
            await q.execute('DELETE FROM ft_appstores_revenue WHERE app_id = ? AND store = ? AND day BETWEEN ? AND ?', [
                appId,
                store,
                fromDay,
                toDay
            ]);
            for (let at = 0; at < rows.length; at += BULK) {
                const chunk = rows
                    .slice(at, at + BULK)
                    .map((r) => [appId, store, r.day, r.currency, r.amount, r.units]);
                await q.execute(
                    `INSERT INTO ft_appstores_revenue (app_id, store, day, currency, amount, units)
                     VALUES ?
                     ON DUPLICATE KEY UPDATE amount = VALUES(amount), units = VALUES(units)`,
                    [chunk]
                );
            }
        },
        async dailyRows(appId, fromDay, toDay) {
            return q.query<DailyRow>(
                `SELECT store, day, downloads, rating_avg, crash_rate, anr_rate, vitals_users
                   FROM ft_appstores_daily
                  WHERE app_id = ? AND day BETWEEN ? AND ?
                  ORDER BY day ASC`,
                [appId, fromDay, toDay]
            );
        },
        async revenueRows(appId, fromDay, toDay) {
            return q.query<RevenueRow>(
                `SELECT store, day, currency, amount, units FROM ft_appstores_revenue
                  WHERE app_id = ? AND day BETWEEN ? AND ?
                  ORDER BY day ASC`,
                [appId, fromDay, toDay]
            );
        },
        async countryTotals(appId, store, fromDay, toDay) {
            const rows = await q.query<{ country: string; downloads: number }>(
                `SELECT country, SUM(downloads) AS downloads
                   FROM ft_appstores_countries
                  WHERE app_id = ? AND (? IS NULL OR store = ?) AND day BETWEEN ? AND ?
                  GROUP BY country
                  ORDER BY downloads DESC, country ASC`,
                [appId, store, store, fromDay, toDay]
            );
            return rows.map((row) => ({ country: row.country, downloads: Number(row.downloads) }));
        },
        async purgeCountriesBefore(day) {
            const res = await q.execute('DELETE FROM ft_appstores_countries WHERE day < ? LIMIT 5000', [day]);
            return res.affectedRows;
        },
        async downloadsOf(appIds, fromDay, toDay) {
            if (appIds.length === 0) return [];
            return q.query<{ app_id: number; store: AppStore; day: number; downloads: number | null }>(
                `SELECT app_id, store, day, downloads FROM ft_appstores_daily
                  WHERE app_id IN (?) AND day BETWEEN ? AND ?`,
                [[...appIds], fromDay, toDay]
            );
        },

        async findReview(id) {
            const rows = await q.query<ReviewRow>('SELECT * FROM ft_appstores_reviews WHERE id = ?', [id]);
            return rows[0] ?? null;
        },
        async listReviews(appId, filter, limit) {
            const { store, rating, unanswered, before } = filter;
            return q.query<ReviewRow>(
                `SELECT * FROM ft_appstores_reviews
                  WHERE app_id = ?
                    ${store ? 'AND store = ?' : ''}
                    ${rating ? 'AND rating = ?' : ''}
                    ${unanswered ? 'AND replied_at IS NULL' : ''}
                    ${before ? 'AND (created_at < ? OR (created_at = ? AND id < ?))' : ''}
                  ORDER BY created_at DESC, id DESC
                  LIMIT ?`,
                [
                    appId,
                    ...(store ? [store] : []),
                    ...(rating ? [rating] : []),
                    ...(before ? [before.createdAt, before.createdAt, before.id] : []),
                    limit
                ]
            );
        },
        async reviewCounts(appId, store, from, split, to) {
            const rows = await q.query<{ rating: number; previous: number; current: number }>(
                `SELECT rating,
                        COUNT(CASE WHEN created_at < ? THEN 1 END) AS previous,
                        COUNT(CASE WHEN created_at >= ? THEN 1 END) AS current
                   FROM ft_appstores_reviews
                  WHERE app_id = ? AND (? IS NULL OR store = ?) AND created_at >= ? AND created_at < ?
                  GROUP BY rating`,
                [split, split, appId, store, store, from, to]
            );
            return rows.map((row) => ({
                rating: Number(row.rating),
                previous: Number(row.previous),
                current: Number(row.current)
            }));
        },
        async reviewsByRefs(appId, store, refs) {
            if (refs.length === 0) return [];
            return q.query<ReviewRow>(
                'SELECT * FROM ft_appstores_reviews WHERE app_id = ? AND store = ? AND external_ref IN (?)',
                [appId, store, [...refs]]
            );
        },
        async insertReview({ appId, store, externalRef, rating, createdAt, repliedAt, content }) {
            const res = await q.execute(
                `INSERT IGNORE INTO ft_appstores_reviews
                     (app_id, store, external_ref, rating, created_at, replied_at, content)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [appId, store, externalRef, rating, createdAt, repliedAt, content]
            );
            return res.affectedRows > 0;
        },
        async updateReview(id, { rating, repliedAt, content }) {
            await q.execute('UPDATE ft_appstores_reviews SET rating = ?, replied_at = ?, content = ? WHERE id = ?', [
                rating,
                repliedAt,
                content,
                id
            ]);
        },
        async repliedSince(appId, store, since) {
            return q.query<ReviewRow>(
                `SELECT * FROM ft_appstores_reviews
                  WHERE app_id = ? AND store = ? AND replied_at >= ?
                  ORDER BY replied_at DESC
                  LIMIT 50`,
                [appId, store, since]
            );
        },
        async purgeReviewsBefore(cutoff) {
            const res = await q.execute('DELETE FROM ft_appstores_reviews WHERE created_at < ? LIMIT 5000', [cutoff]);
            return res.affectedRows;
        },
        async overflowingReviews(max) {
            return q.query<{ app_id: number; store: AppStore }>(
                `SELECT app_id, store FROM ft_appstores_reviews
                  GROUP BY app_id, store
                 HAVING COUNT(*) > ?`,
                [max]
            );
        },
        async trimReviews(appId, store, keep) {
            const edge = await q.query<{ created_at: number; id: number }>(
                `SELECT created_at, id FROM ft_appstores_reviews
                  WHERE app_id = ? AND store = ?
                  ORDER BY created_at DESC, id DESC
                  LIMIT 1 OFFSET ?`,
                [appId, store, keep - 1]
            );
            const last = edge[0];
            if (!last) return 0;
            const res = await q.execute(
                `DELETE FROM ft_appstores_reviews
                  WHERE app_id = ? AND store = ? AND (created_at < ? OR (created_at = ? AND id < ?))`,
                [appId, store, last.created_at, last.created_at, last.id]
            );
            return res.affectedRows;
        }
    };
}
