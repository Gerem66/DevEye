import type { DebugRun } from '@deveye/types';

import { StatusBadge } from '@/Components/StatusBadge';
import { formatMoment, formatMs } from '../format';
import styles from '../Debug.module.css';

const STATUS: Record<DebugRun['status'], { label: string; tone: 'accent' | 'success' | 'danger' | 'neutral' }> = {
    running: { label: 'En cours', tone: 'accent' },
    passed: { label: 'Réussi', tone: 'success' },
    failed: { label: 'En échec', tone: 'danger' },
    aborted: { label: 'Arrêté', tone: 'neutral' }
};

export function RunStatusBadge({ status }: { status: DebugRun['status'] }) {
    return <StatusBadge tone={STATUS[status].tone}>{STATUS[status].label}</StatusBadge>;
}

/** Les essais passés de ce serveur ; un clic affiche le rapport de l'un d'eux. */
export default function RunHistory({
    runs,
    selectedId,
    onSelect,
    summary
}: {
    runs: readonly DebugRun[];
    selectedId: number | null;
    onSelect: (run: DebugRun) => void;
    summary: (run: DebugRun) => string;
}) {
    if (runs.length === 0) return null;
    return (
        <section className={styles.section}>
            <span className={styles.sectionLabel}>Historique</span>
            <div className={styles.card}>
                {runs.map((run) => (
                    <button
                        key={run.id}
                        type='button'
                        className={`${styles.row} ${styles.rowButton} ${run.id === selectedId ? styles.rowSelected : ''}`}
                        onClick={() => onSelect(run)}
                    >
                        <div className={styles.rowText}>
                            <span className={styles.rowTitle}>
                                {formatMoment(run.startedAt)}
                                {run.launchedBy ? `, par ${run.launchedBy.username}` : ''}
                            </span>
                            <span className={styles.rowMeta}>
                                {summary(run)}
                                {run.finishedAt !== null ? ` · ${formatMs(run.finishedAt - run.startedAt)}` : ''}
                            </span>
                        </div>
                        <RunStatusBadge status={run.status} />
                    </button>
                ))}
            </div>
        </section>
    );
}
