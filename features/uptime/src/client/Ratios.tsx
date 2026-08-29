import { formatRatio } from './format';
import styles from './style.module.css';

import type { UptimeService } from '../contracts/domain';

/**
 * La disponibilité sur les trois fenêtres usuelles, toujours les trois et dans
 * cet ordre : un chiffre seul ne veut rien dire. Deux formes : colonne alignée
 * dans la liste, note de bas de graphique sous les barres d'un projet.
 */

const WINDOWS = ['24 h', '7 j', '30 j'] as const;

/** Les trois taux seuls : Projets pose ce composant sur `UptimeLinkedService`. */
export type RatiosService = Pick<UptimeService, 'ratio24h' | 'ratio7d' | 'ratio30d'>;

function valuesOf(service: RatiosService): (number | null)[] {
    return [service.ratio24h, service.ratio7d, service.ratio30d];
}

interface RatiosProps {
    service: RatiosService;
    /** Forme discrète, en une ligne, pour un coin de graphique. */
    compact?: boolean;
}

export function Ratios({ service, compact = false }: RatiosProps) {
    const values = valuesOf(service);

    if (compact) {
        return (
            <span className={styles.ratiosCompact}>
                {WINDOWS.map((label, i) => (
                    <span key={label} className={styles.ratioCompact}>
                        <span className={styles.ratioCompactLabel}>{label}</span>
                        {formatRatio(values[i])}
                    </span>
                ))}
            </span>
        );
    }

    return (
        <div className={styles.cardRatios}>
            {WINDOWS.map((label, i) => (
                <span key={label} className={styles.ratio}>
                    <span className={styles.ratioValue}>{formatRatio(values[i])}</span>
                    <span className={styles.ratioLabel}>{label}</span>
                </span>
            ))}
        </div>
    );
}

export default Ratios;
