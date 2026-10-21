import type { UptimeIntegrityOutcome, UptimeIntegrityReading } from '../contracts/domain';

import { formatMs } from '../contracts/format';
import type { Detail } from './DetailDialog';
import { formatMoment } from './format';
import styles from './style.module.css';

const OUTCOMES: Record<UptimeIntegrityOutcome, { label: string; dot: string }> = {
    learned: { label: 'Référence apprise', dot: styles.dotInfo },
    conform: { label: 'Conforme', dot: styles.dotUp },
    drift: { label: 'Écart', dot: styles.dotDown },
    failed: { label: 'Lecture ratée', dot: styles.dotWarn },
    accepted: { label: 'Acceptée', dot: styles.dotInfo },
    pending: { label: 'En attente d’un déploiement', dot: styles.dotWarn }
};

/** Ce que dit une lecture après son constat : ses fichiers, ou ce qui ne va pas. */
function describe(reading: UptimeIntegrityReading): string {
    if (reading.error !== null) return reading.error;
    const parts: string[] = [];
    if (reading.fileCount !== null) parts.push(`${reading.fileCount} fichier${reading.fileCount > 1 ? 's' : ''}`);
    if (reading.slowestMs !== null) parts.push(`le plus lent en ${formatMs(reading.slowestMs)}`);
    return parts.join(', ');
}

interface ReadingRowProps {
    reading: UptimeIntegrityReading;
    /** « Détails » : ce que la ligne ne montre pas, pour le dialogue de l'appelant. */
    onDetail: (detail: Detail) => void;
}

/** Une lecture des fichiers, sur une ligne : la même dans l'aperçu de la fiche et dans le journal complet. */
export function ReadingRow({ reading, onDetail }: ReadingRowProps) {
    const outcome = OUTCOMES[reading.outcome];
    return (
        <li className={styles.checkRow}>
            <span className={`${styles.dot} ${outcome.dot}`} aria-hidden='true' />
            <span className={styles.checkWhen}>{formatMoment(reading.at)}</span>
            <span className={styles.readingOutcome}>{outcome.label}</span>
            <span className={styles.readingText}>{describe(reading)}</span>
            {/* Ses fichiers, ou ce qui explique le constat : plus que la ligne n'en montre. */}
            {(reading.lines.length > 0 || reading.error !== null) && (
                <button
                    type='button'
                    className={styles.detailLink}
                    onClick={() =>
                        onDetail({
                            title: `${outcome.label} du ${formatMoment(reading.at)}`,
                            description: describe(reading),
                            lines: reading.lines
                        })
                    }
                >
                    Détails
                </button>
            )}
        </li>
    );
}

export default ReadingRow;
