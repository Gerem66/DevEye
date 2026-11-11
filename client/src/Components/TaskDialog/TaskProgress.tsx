import { ProgressBar } from '@/Components/ProgressBar';
import { raiseTask, useTaskRecords, type Task } from '@/stores/tasks';

import styles from './TaskDialog.module.css';

export interface TaskProgressProps {
    task: Task;
    className?: string;
}

/**
 * L'avancement d'une opération, dessiné dans l'écran qui l'a lancée. La zone
 * des opérations de la barre est sous le voile de tout dialogue ouvert : sans
 * cette rangée, un écran en dialogue ne dirait plus rien d'une opération réduite.
 */
export function TaskProgress({ task, className }: TaskProgressProps) {
    // Lancée ailleurs (un autre onglet, cette page avant un rechargement) : aucun dialogue à ramener.
    const owned = useTaskRecords().some((record) => record.id === task.id && record.owned);
    return (
        <div className={`${styles.inline} ${className ?? ''}`}>
            <div className={styles.inlineHead}>
                <span className={styles.inlineTitle}>
                    {task.title}
                    {task.subject && <span className={styles.inlineSubject}> · {task.subject}</span>}
                </span>
                {owned && (
                    <button type='button' className={styles.inlineShow} onClick={() => raiseTask(task.id)}>
                        Afficher
                    </button>
                )}
            </div>
            <ProgressBar value={task.value} label={task.title} />
            <span className={styles.inlineStep}>{task.step ?? 'En cours…'}</span>
        </div>
    );
}

export default TaskProgress;
