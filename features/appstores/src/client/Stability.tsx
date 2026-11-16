import { useState } from 'react';
import { ErrorNote, StatusBadge, useResource } from 'deveye-sdk-client';
import {
    APPSTORES_ANR_THRESHOLD,
    APPSTORES_CRASH_THRESHOLD,
    APPSTORES_VITALS_WINDOW_DAYS,
    type AppStoresApp,
    type AppStoresPoint,
    type AppStoresRange,
    type AppStoresSource
} from '../contracts/domain';

import { api } from './api';
import CapabilityNote from './CapabilityNote';
import { bucketStarts, DEFAULT_RANGE, formatDay, formatRate } from './format';
import RangeBar from './Stats/RangeBar';
import TrendChart from './Stats/TrendChart';
import styles from './style.module.css';

interface StabilityProps {
    app: AppStoresApp;
    sources: readonly AppStoresSource[] | null;
}

interface Measure {
    key: 'crash' | 'anr';
    title: string;
    threshold: number;
    pick: (point: AppStoresPoint) => number | null;
}

const MEASURES: readonly Measure[] = [
    { key: 'crash', title: 'Plantages', threshold: APPSTORES_CRASH_THRESHOLD, pick: (point) => point.crashRate },
    {
        key: 'anr',
        title: 'Blocages (« L’application ne répond pas »)',
        threshold: APPSTORES_ANR_THRESHOLD,
        pick: (point) => point.anrRate
    }
];

/**
 * La stabilité d'une app Android, telle que Google la mesure : un jour sans
 * mesure reste un trou, jamais un zéro, qui se lirait comme une app parfaite.
 */
export function Stability({ app, sources }: StabilityProps) {
    const [range, setRange] = useState<AppStoresRange>(DEFAULT_RANGE);
    const { data: stats, error } = useResource(
        'appstores.stats',
        () => api.send('appstores.stats', { appId: app.id, range }).then((res) => res.stats),
        'La stabilité de cette app n’a pas pu être lue.',
        [app.id, range]
    );

    const rates = stats ? { crash: stats.metrics.crashRate, anr: stats.metrics.anrRate } : null;
    const empty = rates && rates.crash === null && rates.anr === null ? (['google'] as const) : [];

    return (
        <section className={styles.block}>
            <header className={styles.blockHead}>
                <p className={styles.until}>
                    {stats?.dataUntil ? `Données jusqu’au ${formatDay(stats.dataUntil)}` : ''}
                </p>
                <RangeBar value={range} onChange={setRange} />
            </header>
            <p className={styles.blockHint}>
                Chaque jour, Google compte la part des utilisateurs qui ont vu l’app planter, ou se figer au point
                d’afficher « L’application ne répond pas ». Il juge la moyenne des {APPSTORES_VITALS_WINDOW_DAYS}{' '}
                derniers jours : au-dessus de la ligne pointillée, il peut montrer l’app moins souvent dans Google Play
                et prévenir les visiteurs de sa fiche.
            </p>
            <ErrorNote note={error} />
            <CapabilityNote app={app} sources={sources} capabilities={['vitals']} empty={empty} />

            {stats === null || rates === null ? (
                !error && <p className={styles.blockEmpty}>Chargement…</p>
            ) : (
                <div className={styles.measure} data-stale={stats.range !== range ? '' : undefined}>
                    {MEASURES.map((measure) => {
                        const slots = bucketStarts(
                            stats.from,
                            stats.to,
                            stats.bucket,
                            stats.points.map((point) => point.at)
                        );
                        const byAt = new Map(stats.points.map((point) => [point.at, measure.pick(point)]));
                        const average = rates[measure.key];
                        return (
                            <div key={measure.key} className={styles.stabilityMeasure}>
                                {average !== null && average > measure.threshold && (
                                    <p className={styles.stabilityAlert}>
                                        <StatusBadge tone='danger'>
                                            Au-dessus du seuil de Google sur la période
                                        </StatusBadge>
                                    </p>
                                )}
                                <TrendChart
                                    title={measure.title}
                                    slots={slots}
                                    resolution={stats.resolution}
                                    series={[
                                        {
                                            key: 'rate',
                                            label: 'Utilisateurs touchés',
                                            values: slots.map((at) => byAt.get(at) ?? null),
                                            summary:
                                                average === null ? 'non relevé' : `${formatRate(average)} en moyenne`
                                        }
                                    ]}
                                    format={formatRate}
                                    threshold={{
                                        value: measure.threshold,
                                        label: `seuil de Google : ${formatRate(measure.threshold)}`
                                    }}
                                    label={`${measure.title} : ${average === null ? 'non relevé' : `${formatRate(average)} des utilisateurs en moyenne`}, pour un seuil de ${formatRate(measure.threshold)}.`}
                                />
                            </div>
                        );
                    })}
                </div>
            )}
        </section>
    );
}

export default Stability;
