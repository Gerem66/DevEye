import type { AudienceRange } from '../contracts/domain';

import { RANGE_LABELS, RANGES } from './format';
import styles from './style.module.css';

interface RangeBarProps {
    value: AudienceRange;
    onChange: (range: AudienceRange) => void;
}

/**
 * Les fenêtres offertes, du plus près au plus loin. Un groupe de boutons plutôt
 * qu'un `SegmentedControl` : cinq choix dépassent ce que celui-ci sait porter,
 * et chaque bloc qui mesure quelque chose porte le sien.
 */
export function RangeBar({ value, onChange }: RangeBarProps) {
    return (
        <div className={styles.ranges} role='group' aria-label='Période'>
            {RANGES.map((range) => (
                <button
                    key={range}
                    type='button'
                    className={range === value ? styles.rangeActive : styles.range}
                    aria-pressed={range === value}
                    onClick={() => onChange(range)}
                >
                    {RANGE_LABELS[range]}
                </button>
            ))}
        </div>
    );
}

export default RangeBar;
