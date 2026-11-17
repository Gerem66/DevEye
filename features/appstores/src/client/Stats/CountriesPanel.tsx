import { lazy, Suspense, useState } from 'react';
import { SegmentedControl } from 'deveye-sdk-client';
import type { AppStoresStats } from '../../contracts/domain';

import { countryName } from '../format';
import styles from '../style.module.css';
import RankBars from './RankBars';

/** Les tracés du monde ne se chargent qu'à la première carte demandée. */
const CountryMap = lazy(() => import('./CountryMap'));

type CountryView = 'list' | 'map';

interface CountriesPanelProps {
    countries: AppStoresStats['countries'];
    /** Une autre période est en route : celle-ci reste lisible, atténuée. */
    stale: boolean;
}

/** Les téléchargements par pays, en liste ou sur la carte. */
export function CountriesPanel({ countries, stale }: CountriesPanelProps) {
    const [view, setView] = useState<CountryView>('list');

    return (
        <section className={styles.block}>
            <header className={styles.blockHead}>
                <h3 className={styles.blockTitle}>Téléchargements par pays</h3>
                {countries.length > 0 && (
                    <SegmentedControl
                        value={view}
                        options={[
                            { value: 'list', label: 'Liste' },
                            { value: 'map', label: 'Carte' }
                        ]}
                        onChange={setView}
                        aria-label='Affichage des pays'
                    />
                )}
            </header>
            <div className={styles.measure} data-stale={stale ? '' : undefined}>
                {countries.length === 0 ? (
                    <p className={styles.blockEmpty}>Aucun téléchargement relevé sur la période.</p>
                ) : view === 'map' ? (
                    <Suspense fallback={<p className={styles.blockEmpty}>Chargement de la carte…</p>}>
                        <CountryMap countries={countries} />
                    </Suspense>
                ) : (
                    <RankBars
                        items={countries.map((entry) => ({
                            key: entry.country,
                            label: countryName(entry.country),
                            downloads: entry.downloads
                        }))}
                        noun='pays'
                    />
                )}
            </div>
        </section>
    );
}

export default CountriesPanel;
