import Button from '@/Components/Button';
import ErrorNote from '@/Components/ErrorNote';
import { ProgressBar } from '@/Components/ProgressBar';
import type { TaskRecord } from '@/stores/tasks';

import styles from './TasksStatus.module.css';

export interface TaskRowProps {
    task: TaskRecord;
    /** La fonctionnalité qui a lancé l'opération, quand elle est connue ici. */
    feature: { label: string; icon: string } | null;
    /** L'espace d'origine, nommé seulement quand ce n'est pas l'actif. */
    workspaceName?: string | null;
    onShow: () => void;
    onCancel: () => void;
    /** `null` : rien à ouvrir. */
    onOpen: (() => void) | null;
    onDismiss: () => void;
}

/** Une opération dans le panneau : d'où elle vient, où elle en est, ce qu'elle a donné. */
export function TaskRow({ task, feature, workspaceName, onShow, onCancel, onOpen, onDismiss }: TaskRowProps) {
    const origin = [feature?.label, workspaceName].filter(Boolean).join(' · ');
    const settled = task.state === 'done' || task.state === 'lost';
    const tone = task.state === 'done' ? styles.done : task.state === 'lost' ? styles.lost : '';

    return (
        <div className={`${styles.row} ${tone}`}>
            {(origin !== '' || settled) && (
                <div className={styles.rowHead}>
                    {feature && <span className={`icon icon-${feature.icon} ${styles.glyph}`} />}
                    <span className={styles.rowOrigin}>{origin}</span>
                    {settled && (
                        <button
                            type='button'
                            className={styles.rowDismiss}
                            title='Retirer de la liste'
                            aria-label='Retirer de la liste'
                            onClick={onDismiss}
                        >
                            <span className={`icon icon-x ${styles.glyph}`} />
                        </button>
                    )}
                </div>
            )}
            <span className={styles.rowTitle}>{task.title}</span>
            {task.subject && <span className={styles.rowSubject}>{task.subject}</span>}

            {task.state === 'running' && (
                <>
                    <ProgressBar value={task.value} label={task.title} />
                    <span className={styles.rowStep}>{task.step ?? 'En cours…'}</span>
                    <div className={styles.rowActions}>
                        {task.cancellable && (
                            <button type='button' className={styles.rowAction} onClick={onCancel}>
                                Annuler
                            </button>
                        )}
                        <button type='button' className={styles.rowAction} onClick={onShow}>
                            Afficher
                        </button>
                    </div>
                </>
            )}

            {settled && (
                <>
                    <div className={styles.rowResult}>
                        <span
                            className={`icon icon-${task.state === 'done' ? 'check-circle' : 'warning'} ${styles.glyph}`}
                        />
                        <span>{task.state === 'done' ? task.note : task.error?.message}</span>
                    </div>
                    {onOpen && (
                        <div className={styles.rowActions}>
                            <button type='button' className={styles.rowAction} onClick={onOpen}>
                                Ouvrir
                            </button>
                        </div>
                    )}
                </>
            )}

            {task.state === 'failed' && (
                <ErrorNote note={task.error ?? null} inline onDismiss={onDismiss}>
                    {onOpen && (
                        <Button variant='secondary' onClick={onOpen}>
                            Ouvrir
                        </Button>
                    )}
                </ErrorNote>
            )}
        </div>
    );
}

export default TaskRow;
