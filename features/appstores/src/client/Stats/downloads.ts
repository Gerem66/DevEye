import type {
    AppStore,
    AppStoresMetrics,
    AppStoresOverview,
    AppStoresPoint,
    AppStoresStats
} from '../../contracts/domain';

import { absentValue, bucketStarts, formatCount, STORE_LABELS } from '../format';
import type { CurveView } from '../prefs';
import type { TrendSeries } from './TrendChart';

/** Les apps nommées une à une dans la vue « par app » ; les suivantes se regroupent. */
const APPS_SHOWN = 5;

/** La somme des stores où l'app est ; `null` quand aucun n'a rien relevé. */
export function downloadsOf(metrics: AppStoresMetrics, stores: readonly AppStore[]): number | null {
    const known = stores.map((store) => metrics.downloads[store]).filter((value): value is number => value !== null);
    return known.length === 0 ? null : known.reduce((sum, value) => sum + value, 0);
}

type Window = Pick<AppStoresStats, 'from' | 'to' | 'bucket' | 'points' | 'metrics' | 'dataUntil'>;

/** La courbe des téléchargements de la fenêtre, une série par store, dans l'ordre donné. */
export function downloadSeries(stats: Window, stores: readonly AppStore[]): { slots: number[]; series: TrendSeries[] } {
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

/** La somme de plusieurs valeurs d'un seau ; `null` quand aucune n'est relevée. */
function sumKnown(values: readonly (number | null | undefined)[]): number | null {
    const known = values.filter((value): value is number => typeof value === 'number');
    return known.length === 0 ? null : known.reduce((sum, value) => sum + value, 0);
}

const totalOf = (series: readonly TrendSeries[], index: number) => sumKnown(series.map((s) => s.values[index]));

const pointTotal = (point: AppStoresPoint | undefined, stores: readonly AppStore[]) =>
    point === undefined
        ? null
        : sumKnown(stores.map((store) => (store === 'apple' ? point.appleDownloads : point.googleDownloads)));

const summed = (values: readonly (number | null)[]) => {
    const total = sumKnown(values);
    return total === null ? 'non relevé' : `${formatCount(total)} au total`;
};

/** La vue tracée : sur un seul store, le total est la courbe du store, dans sa couleur. */
export function curveViewOf(view: CurveView, stores: readonly AppStore[]): CurveView {
    return view === 'total' && stores.length === 1 ? 'stores' : view;
}

/**
 * Les courbes de la vue choisie. La période d'avant s'aligne seau par seau sur
 * celle-ci ; la moyenne sur 7 jours puise dans ses derniers jours pour être
 * juste dès le premier ; « par app » demande les seaux de chaque app.
 */
export function downloadCurves(
    stats: Window & Pick<AppStoresStats, 'previousPoints' | 'resolution'>,
    stores: readonly AppStore[],
    view: CurveView,
    apps: AppStoresOverview['apps'] = []
): { slots: number[]; series: TrendSeries[] } {
    const byStore = downloadSeries(stats, stores);
    const { slots } = byStore;
    if (curveViewOf(view, stores) === 'stores') return byStore;

    const totals = slots.map((_, index) => totalOf(byStore.series, index));
    const total: TrendSeries = { key: 'total', label: 'Total', values: totals, summary: summed(totals) };
    if (view === 'total') return { slots, series: [total] };

    if (view === 'previous') {
        const previous = slots.map((_, index) => pointTotal(stats.previousPoints[index], stores));
        return {
            slots,
            series: [total, { key: 'previous', label: 'Période d’avant', values: previous, summary: summed(previous) }]
        };
    }

    if (view === 'average') {
        // Un seau d'une semaine contient déjà ses sept jours ; sinon, chaque jour puise dans les six d'avant.
        const before = stats.previousPoints.map((point) => pointTotal(point, stores));
        const days = [...before, ...totals];
        const values = totals.map((value, index) => {
            if (stats.resolution === 'week') return value === null ? null : Math.round(value / 7);
            const window = days.slice(Math.max(0, before.length + index - 6), before.length + index + 1);
            const known = window.filter((day): day is number => day !== null);
            return value === null || known.length === 0
                ? null
                : Math.round(known.reduce((sum, day) => sum + day, 0) / known.length);
        });
        const daily = sumKnown(totals);
        const span = stats.resolution === 'week' ? slots.length * 7 : slots.length;
        return {
            slots,
            series: [
                {
                    key: 'average',
                    label: 'Moyenne sur 7 jours',
                    values,
                    summary: daily === null ? 'non relevé' : `${formatCount(Math.round(daily / span))} par jour`
                }
            ]
        };
    }

    const named = apps.slice(0, APPS_SHOWN).map((app, rank) => ({
        key: `rank${rank}`,
        label: app.name,
        icon: app.icon,
        values: slots.map((_, index) => app.points[index] ?? null),
        summary: app.downloads === null ? 'non relevé' : `${formatCount(app.downloads)} au total`
    }));
    const rest = apps.slice(APPS_SHOWN);
    if (rest.length === 0) return { slots, series: named };
    const others = slots.map((_, index) => sumKnown(rest.map((app) => app.points[index])));
    return {
        slots,
        series: [...named, { key: 'others', label: 'Autres apps', values: others, summary: summed(others) }]
    };
}
