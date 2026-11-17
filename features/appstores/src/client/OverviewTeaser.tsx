import { useResource } from 'deveye-sdk-client';
import type { AppStore } from '../contracts/domain';

import { api } from './api';
import { DEFAULT_RANGE, formatCount, RANGE_LABELS } from './format';
import { downloadSeries, downloadsOf } from './Stats/downloads';
import { relativeChange } from './Stats/StatBand';
import { roundedPath } from './Stats/TrendChart';
import styles from './style.module.css';

const W = 720;
const H = 64;
/** De quoi ne pas couper le trait sur les bords. */
const PAD = 3;

interface OverviewTeaserProps {
    /** Les stores où au moins une app est reliée. */
    stores: readonly AppStore[];
    onOpen: () => void;
}

/**
 * Au-dessus de la liste, l'essentiel de la vue d'ensemble : le total des
 * téléchargements de toutes les apps, son écart et sa courbe. Un clic ouvre
 * la vue entière.
 */
export function OverviewTeaser({ stores, onOpen }: OverviewTeaserProps) {
    const { data: overview } = useResource(
        'appstores.stats',
        () => api.send('appstores.overview', { range: DEFAULT_RANGE }).then((res) => res.overview),
        'La vue d’ensemble n’a pas pu être lue.',
        []
    );
    if (overview === null || overview.dataUntil === null) return null;

    const total = downloadsOf(overview.metrics, stores);
    const change = overview.previousCovered ? relativeChange(total, downloadsOf(overview.previous, stores)) : null;
    const { series } = downloadSeries(overview, stores);
    const sums = series[0]?.values.map((_, i) => {
        const known = series.map((s) => s.values[i]).filter((value): value is number => value !== null);
        return known.length === 0 ? null : known.reduce((sum, value) => sum + value, 0);
    });
    // Cadrée sur ses relevés et non sur zéro : à cette hauteur, c'est la tendance qui se lit, pas l'ordre de grandeur.
    const known = (sums ?? []).filter((value): value is number => value !== null);
    const top = Math.max(1, ...known);
    const low = Math.max(0, Math.min(top, ...known) - (top - Math.min(top, ...known)) * 0.2);
    const span = Math.max(1, top - low);
    const step = W / Math.max(1, (sums?.length ?? 1) - 1);
    // Une suite de jours relevés, un trait ; un trou reste un trou.
    const runs: [number, number][][] = [];
    (sums ?? []).forEach((value, i) => {
        if (value === null) return void runs.push([]);
        if (runs.length === 0) runs.push([]);
        runs[runs.length - 1].push([i * step, H - PAD - ((value - low) / span) * (H - 2 * PAD)]);
    });

    return (
        <button type='button' className={styles.teaser} onClick={onOpen} title='Ouvrir la vue d’ensemble'>
            <span className={styles.teaserFigures}>
                <span className={styles.bandLabel}>Téléchargements · {RANGE_LABELS[DEFAULT_RANGE]}</span>
                <span className={styles.teaserValue}>
                    {total === null ? '–' : formatCount(total)}
                    {change && (
                        <span className={styles.rowDelta} data-tone={change.tone}>
                            {change.text}
                        </span>
                    )}
                </span>
                <span className={styles.teaserMore}>Vue d’ensemble</span>
            </span>
            <svg
                viewBox={`0 0 ${W} ${H}`}
                preserveAspectRatio='none'
                className={styles.sparkline}
                role='img'
                aria-label={`Téléchargements de toutes les apps : ${total === null ? 'non relevés' : formatCount(total)}.`}
            >
                {runs
                    .filter((run) => run.length > 1)
                    .map((run) => (
                        <path key={run[0][0]} d={roundedPath(run)} className={styles.sparkLine} />
                    ))}
            </svg>
        </button>
    );
}

export default OverviewTeaser;
