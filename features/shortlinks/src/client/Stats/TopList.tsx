import type { ReactNode } from 'react';

import type { ShortlinkDimension, ShortlinkTopRow } from '../../contracts/domain';
import { DIMENSION_HINTS, DIMENSION_TITLES, formatCount, formatShare, plural, rowLabel } from '../format';
import styles from '../style.module.css';

interface TopListProps {
    dimension: ShortlinkDimension;
    rows: readonly ShortlinkTopRow[];
    /** Les visites de la période, pour la part de chaque ligne. */
    total: number;
    /** Sous la liste : la mention qu'une source exige à côté de ses chiffres. */
    footer?: ReactNode;
}

/**
 * Les premiers d'un classement. La barre est derrière le texte, à l'échelle du
 * premier et non du total : rapportées au total, dix parts moyennes seraient
 * toutes minuscules.
 */
export default function TopList({ dimension, rows, total, footer }: TopListProps) {
    const max = Math.max(1, ...rows.map((row) => row.visits));
    return (
        <section className={styles.panel}>
            <h3 className={styles.panelTitle} title={DIMENSION_HINTS[dimension]}>
                {DIMENSION_TITLES[dimension]}
            </h3>
            {rows.length === 0 ? (
                <p className={styles.panelEmpty}>Aucune visite sur la période.</p>
            ) : (
                <ol className={styles.topList}>
                    {rows.map((row, index) => {
                        const label = rowLabel(dimension, row.label);
                        return (
                            <li key={`${row.label}-${index}`} className={styles.topRow}>
                                <span
                                    className={styles.topBar}
                                    style={{ width: `${(row.visits / max) * 100}%` }}
                                    aria-hidden='true'
                                />
                                <span
                                    className={row.label.length === 0 ? styles.topLabelMuted : styles.topLabel}
                                    title={label}
                                >
                                    {label}
                                </span>
                                <span className={styles.topValue} title={plural(row.visits, 'visite', 'visites')}>
                                    {formatCount(row.visits)}
                                    <span className={styles.topShare}>{formatShare(row.visits, total)}</span>
                                </span>
                            </li>
                        );
                    })}
                </ol>
            )}
            {footer}
        </section>
    );
}
