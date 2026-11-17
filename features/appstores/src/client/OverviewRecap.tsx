import { useResource } from 'deveye-sdk-client';
import type { AppStore } from '../contracts/domain';

import { api } from './api';
import { DEFAULT_RANGE, formatCount, MISSING, RANGE_LABELS } from './format';
import { useStoresPrefs } from './prefs';
import { downloadCurves, downloadsOf } from './Stats/downloads';
import { relativeChange } from './Stats/StatBand';
import TrendChart from './Stats/TrendChart';
import styles from './style.module.css';

interface OverviewRecapProps {
    /** Les stores où au moins une app est reliée. */
    stores: readonly AppStore[];
    onOpen: () => void;
}

/**
 * Au-dessus de la liste, l'essentiel de la vue d'ensemble sur 30 jours :
 * quelques chiffres et la courbe. Tout le panneau ouvre la vue entière.
 */
export function OverviewRecap({ stores, onOpen }: OverviewRecapProps) {
    // La vue choisie dans la vue d'ensemble : le panneau ne la règle pas, tout clic l'ouvrant.
    const view = useStoresPrefs('overview').curveView;
    const { data: overview } = useResource(
        'appstores.stats',
        () => api.send('appstores.overview', { range: DEFAULT_RANGE }).then((res) => res.overview),
        'La vue d’ensemble n’a pas pu être lue.',
        []
    );
    if (overview === null || overview.dataUntil === null) return null;

    const total = downloadsOf(overview.metrics, stores);
    const change = overview.previousCovered ? relativeChange(total, downloadsOf(overview.previous, stores)) : null;
    const { slots, series } = downloadCurves(overview, stores, view, overview.apps);
    const figures = [
        { key: 'reviews', label: 'Avis reçus', value: formatCount(overview.metrics.reviews) },
        { key: 'unanswered', label: 'Sans réponse', value: formatCount(overview.unanswered) },
        ...(overview.alerts.length > 0
            ? [{ key: 'alerts', label: 'En alerte', value: formatCount(overview.alerts.length) }]
            : [])
    ];

    return (
        // `div role="button"` : le panneau porte une figure et une liste, interdites dans un `<button>`.
        <div
            className={styles.recap}
            role='button'
            tabIndex={0}
            title='Ouvrir la vue d’ensemble'
            onClick={onOpen}
            onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onOpen();
                }
            }}
        >
            <div className={styles.recapHead}>
                <span className={styles.bandLabel}>Toutes les apps · {RANGE_LABELS[DEFAULT_RANGE]}</span>
                <span className={styles.recapMore}>
                    Vue d’ensemble
                    <span className='icon icon-move-to-right' aria-hidden='true' />
                </span>
            </div>
            <dl className={styles.recapFigures}>
                <div className={styles.recapFigure}>
                    <dt className={styles.bandLabel}>Téléchargements</dt>
                    <dd className={styles.recapValue}>
                        {total === null ? MISSING : formatCount(total)}
                        {change && (
                            <span className={styles.rowDelta} data-tone={change.tone}>
                                {change.text}
                            </span>
                        )}
                    </dd>
                </div>
                {figures.map((figure) => (
                    <div key={figure.key} className={styles.recapFigure}>
                        <dt className={styles.bandLabel}>{figure.label}</dt>
                        <dd className={styles.recapValue}>{figure.value}</dd>
                    </div>
                ))}
            </dl>
            <TrendChart
                slots={slots}
                resolution={overview.resolution}
                series={series}
                format={formatCount}
                compact
                label={`Téléchargements de toutes les apps : ${total === null ? 'non relevés' : formatCount(total)}.`}
            />
        </div>
    );
}

export default OverviewRecap;
