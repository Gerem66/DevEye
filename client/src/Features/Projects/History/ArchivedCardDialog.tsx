import type { MinimalUser, ProjectCard } from '@deveye/types';
import { Button, Dialog } from '@/Components';
import { formatDate, PRIORITY_LABELS } from '../api';
import { Avatar } from '@/Components/Avatar/Avatar';
import styles from '../style.module.css';

interface ArchivedCardDialogProps {
    open: boolean;
    card: ProjectCard | null;
    members: MinimalUser[];
    canWrite: boolean;
    busy: boolean;
    onClose: () => void;
    onRestore: () => void;
}

/**
 * Un bloc archivé, **en lecture seule**.
 *
 * Rien n'y est modifiable : une carte archivée est un fait passé, et la
 * modifier réécrirait l'histoire que la frise vient de raconter. La seule
 * action possible est de la restaurer — ce qui la fait redevenir vivante, et
 * laisse à son tour une trace.
 */
export function ArchivedCardDialog({
    open,
    card,
    members,
    canWrite,
    busy,
    onClose,
    onRestore
}: ArchivedCardDialogProps) {
    const assignee = members.find((m) => m.id === card?.assigneeUserId);
    const done = card?.checklist.filter((i) => i.done).length ?? 0;

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title='Bloc archivé'
            description={card?.archivedAt ? `Archivé le ${formatDate(card.archivedAt)}` : undefined}
            width={620}
            holdSecrecy
            footer={
                <>
                    <Button variant='secondary' onClick={onClose} disabled={busy}>
                        Fermer
                    </Button>
                    {canWrite && (
                        <Button icon='refresh' onClick={onRestore} disabled={busy}>
                            {busy ? 'Restauration…' : 'Restaurer'}
                        </Button>
                    )}
                </>
            }
        >
            {card && (
                <div className={styles.form}>
                    <h3 className={styles.readonlyTitle}>{card.title || 'Sans titre'}</h3>

                    {card.description && <p className={styles.readonlyText}>{card.description}</p>}

                    <dl className={styles.readonlyMeta}>
                        <div>
                            <dt>Priorité</dt>
                            <dd>{PRIORITY_LABELS[card.priority]}</dd>
                        </div>
                        {card.assigneeUserId !== null && (
                            <div>
                                <dt>Assignée à</dt>
                                <dd className={styles.readonlyAssignee}>
                                    <Avatar user={assignee} size={18} />
                                    {assignee?.username ?? 'Compte supprimé'}
                                </dd>
                            </div>
                        )}
                        {card.dueDate !== null && (
                            <div>
                                <dt>Échéance</dt>
                                <dd>{formatDate(card.dueDate)}</dd>
                            </div>
                        )}
                        {card.messageCount > 0 && (
                            <div>
                                <dt>Messages</dt>
                                <dd>{card.messageCount}</dd>
                            </div>
                        )}
                    </dl>

                    {card.checklist.length > 0 && (
                        <div className={styles.field}>
                            <span className={styles.label}>
                                Sous-tâches — {done}/{card.checklist.length}
                            </span>
                            <ul className={styles.checklist}>
                                {card.checklist.map((item) => (
                                    <li key={item.id} className={styles.checkItem}>
                                        <span
                                            className={`icon icon-${item.done ? 'square-check' : 'square-empty'}`}
                                            aria-hidden='true'
                                        />
                                        <span className={item.done ? styles.checkDone : undefined}>{item.label}</span>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                </div>
            )}
        </Dialog>
    );
}

export default ArchivedCardDialog;
