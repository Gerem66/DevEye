import type { ReactNode } from 'react';
import styles from './organize.module.css';

/** One row of a picker: an icon, a label (+ optional sub-label), and a trailing "+". */
export interface PickerEntry {
    key: string;
    /** Icon name from `Styles/icons.css` (rendered as `icon icon-<name>`). */
    icon: string;
    label: string;
    sub?: string;
    /** Extra element before the "+" (e.g. a device's online dot). */
    trailing?: ReactNode;
    onPick: () => void;
}

/**
 * The vertical list of "things you can add" shared by every add dialog on the
 * home (a section, a device, a feature). Keeps the three pickers visually
 * identical instead of duplicating the same markup per dialog.
 */
export function PickerList({ entries, empty }: { entries: PickerEntry[]; empty: string }) {
    if (entries.length === 0) return <p className={styles.addEmpty}>{empty}</p>;
    return (
        <div className={styles.addList}>
            {entries.map((e) => (
                <button key={e.key} className={styles.addItem} onClick={e.onPick}>
                    <span className={`icon icon-${e.icon} ${styles.addItemIcon}`} />
                    <span className={styles.addItemLabel}>
                        {e.label}
                        {e.sub && <span className={styles.addItemSub}>{e.sub}</span>}
                    </span>
                    {e.trailing}
                    <span className={`icon icon-plus ${styles.addItemPlus}`} />
                </button>
            ))}
        </div>
    );
}

export default PickerList;
