import type { ExposureFinding } from '../contracts/exposure';

import { SOURCE_ICON } from './exposureLabels';
import styles from './style.module.css';

/** Les éléments touchés d'un constat, trois au plus, et combien d'autres. */
export default function AssetChips({ finding }: { finding: ExposureFinding }) {
    const shown = finding.affected.slice(0, 3);
    const more = finding.affected.length - shown.length;
    return (
        <>
            {shown.map((a) => (
                <span key={a.assetId} className={styles.assetChip}>
                    <span className={`icon ${SOURCE_ICON[a.source]} ${styles.assetChipIcon}`} aria-hidden='true' />
                    {a.label}
                </span>
            ))}
            {more > 0 && <span className={styles.assetChip}>+{more}</span>}
        </>
    );
}
