import { useState } from 'react';
import type { AppStoresStats } from '../../contracts/domain';

import { countryName, formatCount, plural } from '../format';
import styles from '../style.module.css';

/** Les pays montrés d'emblée ; les autres se déplient à la demande. */
const SHOWN = 8;

interface CountryBarsProps {
    countries: AppStoresStats['countries'];
}

/** Les pays qui téléchargent le plus, chaque barre rapportée au premier. */
export function CountryBars({ countries }: CountryBarsProps) {
    const [all, setAll] = useState(false);

    if (countries.length === 0) {
        return <p className={styles.blockEmpty}>Aucun téléchargement relevé sur la période.</p>;
    }
    const total = countries.reduce((sum, entry) => sum + entry.downloads, 0);
    const longest = countries[0].downloads;
    const shown = all ? countries : countries.slice(0, SHOWN);

    return (
        <>
            <ol className={styles.countryList}>
                {shown.map(({ country, downloads }) => {
                    const share = downloads / total;
                    return (
                        <li
                            key={country}
                            className={styles.countryRow}
                            title={`${countryName(country)} : ${plural(downloads, 'téléchargement', 'téléchargements')}`}
                        >
                            <span
                                className={styles.countryBar}
                                style={{ width: `${(downloads / longest) * 100}%` }}
                                aria-hidden='true'
                            />
                            <span className={styles.countryName}>{countryName(country)}</span>
                            <span className={styles.countryCount}>
                                {formatCount(downloads)}
                                <span className={styles.countryShare}>
                                    {share < 0.01 ? '< 1 %' : `${Math.round(share * 100)} %`}
                                </span>
                            </span>
                        </li>
                    );
                })}
            </ol>
            {countries.length > SHOWN && (
                <button type='button' className={styles.countryMore} onClick={() => setAll(!all)}>
                    {all ? 'Afficher moins' : `Afficher les ${countries.length} pays`}
                </button>
            )}
        </>
    );
}

export default CountryBars;
