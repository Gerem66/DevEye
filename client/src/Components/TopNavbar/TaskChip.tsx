import type { ChipView } from '@/stores/tasks';

import styles from './TasksStatus.module.css';

const ICON: Record<ChipView['tone'], string> = {
    running: 'spinner',
    failed: 'x-circle',
    lost: 'warning',
    done: 'check-circle'
};

/** En cours, la puce garde son habillage neutre. */
const TONE: Record<ChipView['tone'], string> = {
    running: '',
    failed: styles.failed,
    lost: styles.lost,
    done: styles.done
};

/** Ce que la puce dit à qui ne la voit pas, et en infobulle. */
export function chipLabel(chip: ChipView): string {
    if (chip.tone === 'running') {
        const running = chip.count > 1 ? `${chip.count} opérations en cours` : 'Une opération en cours';
        if (chip.alert === 'failed') return `${running}, un échec à voir`;
        if (chip.alert === 'lost') return `${running}, une interruption à voir`;
        return running;
    }
    if (chip.tone === 'failed') {
        return chip.count > 1 ? `${chip.count} opérations ont échoué` : 'Une opération a échoué';
    }
    if (chip.tone === 'lost') {
        return chip.count > 1 ? `${chip.count} opérations interrompues` : 'Une opération interrompue';
    }
    return chip.count > 1 ? `${chip.count} opérations terminées` : 'Une opération terminée';
}

export interface TaskChipProps {
    chip: ChipView;
    open: boolean;
    /** L'id du panneau que la puce ouvre. */
    panelId: string;
    onClick: () => void;
}

/**
 * La puce des opérations : un sablier tant que quelque chose tourne, puis le
 * ton du résultat qui attend d'être vu.
 */
export function TaskChip({ chip, open, panelId, onClick }: TaskChipProps) {
    const label = chipLabel(chip);
    const alert = chip.alert === 'failed' ? styles.alertFailed : chip.alert === 'lost' ? styles.alertLost : '';
    return (
        <button
            type='button'
            className={`${styles.chip} ${TONE[chip.tone]} ${alert}`}
            title={label}
            aria-label={label}
            aria-haspopup='dialog'
            aria-expanded={open}
            aria-controls={open ? panelId : undefined}
            onClick={onClick}
        >
            <span
                className={`icon icon-${ICON[chip.tone]} ${styles.glyph} ${chip.tone === 'running' ? styles.spin : ''}`}
            />
            {chip.count > 1 && <span className={styles.count}>{chip.count}</span>}
            {chip.value !== undefined && (
                <span className={styles.bar}>
                    <span className={styles.barFill} style={{ width: `${Math.round(chip.value * 100)}%` }} />
                </span>
            )}
        </button>
    );
}

export default TaskChip;
