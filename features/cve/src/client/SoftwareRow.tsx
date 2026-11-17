import { StatusBadge } from 'deveye-sdk-client';

import type { Software } from '../contracts/software';

import { askedSummary, categoryLabel, releaseLabel } from './softwareLabels';
import styles from './style.module.css';

/** Un logiciel trouvé par la recherche : avec une version, la ligne répond déjà. */
export default function SoftwareRow({
    software,
    releases,
    version,
    selected,
    onOpen
}: {
    software: Software;
    releases: readonly string[];
    version: string | null;
    selected: boolean;
    onOpen: () => void;
}) {
    const { asked, badge, line } = askedSummary(software, releases);
    const category = categoryLabel(software.category);
    const suffix = asked ? releaseLabel(asked) : releases.length > 1 ? version : null;

    return (
        <li className={`${styles.row} ${selected ? styles.rowSelected : ''}`}>
            <button type='button' className={styles.rowMain} onClick={onOpen}>
                <span className={styles.rowHead}>
                    <span className={styles.rowId}>
                        {software.label}
                        {suffix && ` ${suffix}`}
                    </span>
                    <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
                    {category && <span className={styles.rowAge}>{category}</span>}
                </span>
                <span className={styles.rowLine}>{line.charAt(0).toUpperCase() + line.slice(1)}</span>
            </button>
        </li>
    );
}
