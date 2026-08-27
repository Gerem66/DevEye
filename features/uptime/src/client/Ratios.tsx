import { formatRatio } from './format';
import styles from './style.module.css';

import type { UptimeService } from '../contracts/domain';

/**
 * La disponibilité sur les trois fenêtres usuelles.
 *
 * Toujours les trois, toujours dans cet ordre : le chiffre d'une seule fenêtre
 * ne veut rien dire seul. « 100 % sur 24 h » se lit autrement à côté d'un
 * « 97 % sur 30 j », qui dit qu'il s'est passé quelque chose la semaine dernière.
 *
 * Deux formes, parce que deux endroits les montrent pour deux raisons. Dans la
 * liste des services, c'est une colonne qu'on parcourt du regard d'une ligne à
 * l'autre : elle est alignée et lisible. Sous les barres d'un projet, c'est une
 * note de bas de graphique : elle chiffre ce que les couleurs viennent de dire,
 * et n'a aucune raison de peser autant que la légende qui lui fait face.
 */

const WINDOWS = ['24 h', '7 j', '30 j'] as const;

/**
 * Les trois taux, et rien d'autre : c'est ce qui permet à Projets de poser ce
 * composant sur le service réduit du contrat client (`UptimeLinkedService`),
 * qui ne porte pas le reste de la fiche.
 */
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
