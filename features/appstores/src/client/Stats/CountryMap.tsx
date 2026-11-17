import { useState } from 'react';
import type { AppStoresStats } from '../../contracts/domain';

import { countryName, formatCount, formatShare, plural } from '../format';
import styles from '../style.module.css';
import { WORLD_SHAPES, WORLD_VIEWBOX } from './worldShapes';

/** Les paliers de la teinte, du plus pâle au plus vif. */
const LEVELS = 5;

interface CountryMapProps {
    /** Non vide, les plus nombreux d'abord. */
    countries: AppStoresStats['countries'];
}

/**
 * Les pays d'une seule teinte, d'autant plus vive qu'ils téléchargent. Le
 * palier suit la racine carrée de la part du premier : un pays qui domine ne
 * laisse pas tous les autres au plus pâle. La liste reste la vue exacte.
 */
export function CountryMap({ countries }: CountryMapProps) {
    const [active, setActive] = useState<string | null>(null);

    const byCountry = new Map(countries.map((entry) => [entry.country, entry.downloads]));
    const total = countries.reduce((sum, entry) => sum + entry.downloads, 0);
    const most = countries[0].downloads;
    const least = countries[countries.length - 1].downloads;
    const levelOf = (downloads: number) => Math.max(1, Math.ceil(Math.sqrt(downloads / most) * LEVELS));
    const offMap = countries.filter((entry) => !(entry.country in WORLD_SHAPES));

    const activeDownloads = active === null ? 0 : (byCountry.get(active) ?? 0);
    const leave = (code: string) => setActive((current) => (current === code ? null : current));

    const hint = (
        <span className={styles.legendWhen}>
            {active === null
                ? 'survolez un pays'
                : activeDownloads === 0
                  ? `${countryName(active)} : aucun téléchargement`
                  : `${countryName(active)} : ${plural(activeDownloads, 'téléchargement', 'téléchargements')} · ${formatShare(activeDownloads / total)}`}
        </span>
    );

    return (
        <figure className={styles.chart}>
            <svg
                viewBox={WORLD_VIEWBOX}
                className={styles.chartSvg}
                role='img'
                aria-label={`Carte des téléchargements par pays : ${countries
                    .slice(0, 3)
                    .map((entry) => `${countryName(entry.country)} ${formatCount(entry.downloads)}`)
                    .join(', ')}.`}
            >
                {Object.entries(WORLD_SHAPES).map(([code, d]) => {
                    const downloads = byCountry.get(code);
                    return (
                        <path
                            key={code}
                            d={d}
                            className={styles.mapCountry}
                            data-level={downloads === undefined ? undefined : levelOf(downloads)}
                            onPointerEnter={() => setActive(code)}
                            onPointerLeave={(e) => e.pointerType === 'mouse' && leave(code)}
                            onClick={() => setActive(code)}
                        />
                    );
                })}
                {/* Repassé par-dessus ses voisins : leurs frontières ne le coupent pas. */}
                {active !== null && <path d={WORLD_SHAPES[active]} className={styles.mapOutline} />}
            </svg>

            {/* Le survol se lit dans l'angle du panneau : sur la dernière ligne, à droite. */}
            <figcaption className={styles.mapCaption}>
                <span className={styles.chartLegend}>
                    <span className={styles.legendItem}>
                        <span className={styles.legendLabel}>{formatCount(least)}</span>
                        <span className={styles.mapScale} aria-hidden='true'>
                            {Array.from({ length: LEVELS }, (_, k) => (
                                <span key={k} className={styles.mapStep} data-level={k + 1} />
                            ))}
                        </span>
                        <span className={styles.legendLabel}>{formatCount(most)}</span>
                    </span>
                    {offMap.length === 0 && hint}
                </span>
                {offMap.length > 0 && (
                    <span className={styles.chartLegend}>
                        <span className={styles.legendLabel}>
                            Trop petits pour la carte :{' '}
                            {offMap
                                .map((entry) => `${countryName(entry.country)} (${formatCount(entry.downloads)})`)
                                .join(', ')}
                            .
                        </span>
                        {hint}
                    </span>
                )}
            </figcaption>
        </figure>
    );
}

export default CountryMap;
