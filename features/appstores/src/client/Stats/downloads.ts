import type { AppStore, AppStoresMetrics, AppStoresStats } from '../../contracts/domain';

import { absentValue, bucketStarts, formatCount, STORE_LABELS } from '../format';
import type { TrendSeries } from './TrendChart';

/** La somme des stores où l'app est ; `null` quand aucun n'a rien relevé. */
export function downloadsOf(metrics: AppStoresMetrics, stores: readonly AppStore[]): number | null {
    const known = stores.map((store) => metrics.downloads[store]).filter((value): value is number => value !== null);
    return known.length === 0 ? null : known.reduce((sum, value) => sum + value, 0);
}

/** La courbe des téléchargements de la fenêtre, une série par store, dans l'ordre donné. */
export function downloadSeries(
    stats: AppStoresStats,
    stores: readonly AppStore[]
): { slots: number[]; series: TrendSeries[] } {
    const slots = bucketStarts(
        stats.from,
        stats.to,
        stats.bucket,
        stats.points.map((point) => point.at)
    );
    const byAt = new Map(stats.points.map((point) => [point.at, point]));
    const series = stores.map((store) => {
        const total = stats.metrics.downloads[store];
        return {
            key: store,
            label: STORE_LABELS[store],
            values: slots.map((at) => {
                const point = byAt.get(at);
                if (!point) return absentValue(at, stats.dataUntil);
                return store === 'apple' ? point.appleDownloads : point.googleDownloads;
            }),
            summary: total === null ? 'non relevé' : `${formatCount(total)} au total`
        };
    });
    return { slots, series };
}
