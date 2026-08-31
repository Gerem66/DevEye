import { StatusBadge } from 'deveye-sdk-client';

import type { CveEntry } from '../contracts/domain';

import { ago, fullDate, SEVERITY_LABEL, severityTone } from './severity';
import styles from './style.module.css';

/** L'id DOM d'une rangée, partagé avec la vue qui la ramène sous les yeux. */
export function rowDomId(cveId: string): string {
    return `cve-row-${cveId}`;
}

interface Props {
    entry: CveEntry;
    selected: boolean;
    canWrite: boolean;
    onOpen: (entry: CveEntry) => void;
    onToggleFavorite: (entry: CveEntry) => void;
}

/** Une CVE dans une liste : ce qu'elle est, ce qu'elle vaut, et l'épingle. */
export default function CveRow({ entry, selected, canWrite, onOpen, onToggleFavorite }: Props) {
    return (
        <li id={rowDomId(entry.id)} className={`${styles.row} ${selected ? styles.rowSelected : ''}`}>
            <button type='button' className={styles.rowMain} onClick={() => onOpen(entry)}>
                <span className={styles.rowHead}>
                    <span className={styles.rowId}>{entry.id}</span>
                    <StatusBadge tone={severityTone(entry.severity)}>
                        {entry.score === null
                            ? SEVERITY_LABEL[entry.severity]
                            : `${SEVERITY_LABEL[entry.severity]} ${entry.score.toFixed(1)}`}
                    </StatusBadge>
                    <span className={styles.rowAge} title={fullDate(entry.published)}>
                        {ago(entry.published)}
                    </span>
                </span>
                <span className={styles.rowSummary}>{entry.summary}</span>
            </button>
            <span className={styles.rowActions}>
                <button
                    type='button'
                    className={styles.starBtn}
                    disabled={!canWrite}
                    title={
                        canWrite
                            ? entry.isFavorite
                                ? 'Retirer des épingles de l’espace'
                                : 'Épingler pour l’espace'
                            : 'Votre rôle ne permet pas d’épingler'
                    }
                    aria-label={entry.isFavorite ? `Retirer l’épingle de ${entry.id}` : `Épingler ${entry.id}`}
                    aria-pressed={entry.isFavorite}
                    onClick={() => onToggleFavorite(entry)}
                >
                    <span className={`icon ${entry.isFavorite ? 'icon-star' : 'icon-star-outline'}`} />
                </button>
                <a
                    className={styles.iconBtn}
                    href={`https://nvd.nist.gov/vuln/detail/${entry.id}`}
                    target='_blank'
                    rel='noreferrer'
                    title='Ouvrir la fiche du NVD'
                    aria-label={`Ouvrir la fiche du NVD de ${entry.id}`}
                >
                    <span className='icon icon-move-to-right' />
                </a>
            </span>
        </li>
    );
}
