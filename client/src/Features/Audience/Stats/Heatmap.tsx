import type { AudienceActivityCell } from 'deveye-types';

import { DAY_LABELS, formatCount } from '../format';
import styles from '../style.module.css';

interface HeatmapProps {
    cells: AudienceActivityCell[];
}

/**
 * La carte jour × heure : quand les gens sont là.
 *
 * **L'heure est celle du visiteur**, reconstituée côté serveur depuis le
 * décalage que son navigateur a déclaré. C'est la seule qui réponde à la
 * question qu'on se pose : en heure serveur, une audience répartie sur trois
 * fuseaux se moyenne en un aplat qui ne dit rien.
 *
 * Une grille CSS de cases, et non un SVG : il n'y a ici ni courbe, ni échelle,
 * ni axe continu — seulement 168 rectangles et leur intensité. Le SVG aurait
 * ajouté un système de coordonnées pour reproduire ce qu'une grille fait seule.
 */
export function Heatmap({ cells }: HeatmapProps) {
    const byKey = new Map(cells.map((c) => [`${c.day}:${c.hour}`, c.views]));
    const max = Math.max(1, ...cells.map((c) => c.views));

    if (cells.length === 0) {
        return <p className={styles.empty}>Pas encore assez de visites pour dessiner une carte d’activité.</p>;
    }

    return (
        <div className={styles.heatmap}>
            <div className={styles.heatmapGrid}>
                {DAY_LABELS.map((label, day) => (
                    <div key={label} className={styles.heatmapRow}>
                        <span className={styles.heatmapDay}>{label}</span>
                        {Array.from({ length: 24 }, (_, hour) => {
                            const views = byKey.get(`${day}:${hour}`) ?? 0;
                            // L'intensité est rapportée au maximum de la carte,
                            // jamais à une échelle absolue : c'est un relief
                            // qu'on lit, pas une valeur qu'on mesure — la valeur
                            // exacte est dans l'info-bulle.
                            return (
                                <span
                                    key={hour}
                                    className={styles.heatmapCell}
                                    style={{ opacity: views === 0 ? undefined : 0.15 + (views / max) * 0.85 }}
                                    data-empty={views === 0 ? '' : undefined}
                                    title={`${label} ${String(hour).padStart(2, '0')} h — ${formatCount(views)} vue${views > 1 ? 's' : ''}`}
                                />
                            );
                        })}
                    </div>
                ))}
            </div>
            {/* Quatre repères seulement : l'axe des heures n'a pas besoin d'être
                lisible heure par heure, il sert à situer un relief. */}
            <div className={styles.heatmapHours}>
                {[0, 6, 12, 18].map((hour) => (
                    <span key={hour} style={{ gridColumnStart: hour + 2 }}>
                        {String(hour).padStart(2, '0')} h
                    </span>
                ))}
            </div>
        </div>
    );
}

export default Heatmap;
