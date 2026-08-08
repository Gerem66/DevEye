import { useCallback, useEffect, useState } from 'react';
import type { MyTask } from 'deveye-types';
import { ws } from '@/api/ws';
import { useResourceVersion } from '@/stores/invalidation';
import { formatDate, humanizeError, PRIORITY_LABELS } from './api';
import styles from './style.module.css';

interface MyTasksProps {
    /** Ouvre le projet auquel appartient la tâche. */
    onOpenProject: (projectId: number) => void;
}

/**
 * Toutes mes tâches, tous projets de l'espace confondus.
 *
 * Rendue possible par le fait qu'`assignee_user_id` est en clair : une seule
 * requête serveur, aucun déchiffrement pour trier. C'est la vue qu'on ouvre le
 * matin, et la raison pour laquelle cette colonne n'a pas été chiffrée.
 *
 * Ne demande **jamais** de mot de passe : les cartes d'un projet confidentiel
 * verrouillé reviennent masquées plutôt qu'absentes — une liste de tâches
 * incomplète serait pire qu'une liste qui dit ce qu'elle ne peut pas lire.
 */
export function MyTasks({ onOpenProject }: MyTasksProps) {
    const [tasks, setTasks] = useState<MyTask[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const version = useResourceVersion('project.myTasks');

    const load = useCallback(async () => {
        try {
            const res = await ws.send('project.myTasks', {});
            setTasks(res.tasks);
            setError(null);
        } catch (e) {
            setError(humanizeError(e, 'Impossible de charger vos tâches.'));
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load, version]);

    const now = Date.now();

    return (
        <div className={styles.myTasks}>
            {error && <p className={styles.error}>{error}</p>}
            {tasks === null && <p className={styles.empty}>Chargement…</p>}
            {tasks?.length === 0 && <p className={styles.empty}>Aucune tâche ne vous est attribuée.</p>}

            {tasks && tasks.length > 0 && (
                <ul className={styles.taskList}>
                    {tasks.map((task) => {
                        const overdue = task.card.dueDate !== null && task.card.dueDate * 1000 < now;
                        const due = formatDate(task.card.dueDate);
                        return (
                            <li key={task.card.id} className={styles.taskItem}>
                                <button type='button' onClick={() => onOpenProject(task.projectId)}>
                                    {task.card.priority !== 'none' && (
                                        <span
                                            className={styles.priority}
                                            data-priority={task.card.priority}
                                            title={`Priorité ${PRIORITY_LABELS[task.card.priority].toLowerCase()}`}
                                        />
                                    )}
                                    <span className={styles.taskTitle}>
                                        {task.masked ? (
                                            <span className={styles.masked}>Tâche d’un projet confidentiel</span>
                                        ) : (
                                            task.card.title || 'Sans titre'
                                        )}
                                    </span>
                                    <span className={styles.taskProject}>
                                        {task.masked ? '—' : task.projectTitle || 'Projet'}
                                    </span>
                                    {due && <span className={overdue ? styles.overdue : styles.itemDate}>{due}</span>}
                                    {task.card.unread > 0 && <span className={styles.unread}>{task.card.unread}</span>}
                                </button>
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
}

export default MyTasks;
