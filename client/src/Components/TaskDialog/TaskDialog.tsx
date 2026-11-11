import { useEffect, useState } from 'react';

import Button from '@/Components/Button';
import { Dialog } from '@/Components/Dialog';
import { ProgressBar } from '@/Components/ProgressBar';
import type { TaskRecord } from '@/stores/tasks';

import styles from './TaskDialog.module.css';

/** Une opération plus courte n'a pas besoin d'un dialogue d'avancement. */
const APPEAR_DELAY_MS = 400;
/** Au-delà, le dialogue dit que c'est long, pour faire patienter plutôt qu'inquiéter. */
const SLOW_AFTER_MS = 8_000;

const SLOW_NOTE = 'Cela prend plus de temps que d’habitude. L’opération continue, merci de patienter.';
const SLOW_MINIMIZABLE_NOTE =
    'Cela prend plus de temps que d’habitude. L’opération continue : vous pouvez la réduire et poursuivre ailleurs.';

export interface TaskDialogProps {
    open: boolean;
    /** La dernière opération montrée, gardée le temps du fondu de sortie. */
    task: TaskRecord | null;
    /** D'où vient l'opération : la fonctionnalité, puis ce qu'elle vise. */
    kicker?: string;
    onMinimize: () => void;
    onCancel: () => void;
}

/**
 * Le dialogue d'une opération longue au premier plan : ce qui se fait, où elle
 * en est, et de quoi rendre la main. Réduire ne l'arrête pas, elle passe dans
 * la zone des opérations de la barre.
 */
export function TaskDialog({ open, task, kicker, onMinimize, onCancel }: TaskDialogProps) {
    const [slow, setSlow] = useState(false);
    const id = task?.id;
    const startedAt = task?.startedAt;
    // Compté depuis le lancement, pas depuis l'affichage : une opération
    // ramenée devant après une minute dit tout de suite qu'elle est longue.
    useEffect(() => {
        if (!open || startedAt === undefined) return;
        const wait = startedAt + SLOW_AFTER_MS - Date.now();
        setSlow(wait <= 0);
        if (wait <= 0) return;
        const timer = setTimeout(() => setSlow(true), wait);
        return () => clearTimeout(timer);
    }, [open, id, startedAt]);

    const minimizable = task?.minimizable ?? false;
    const cancellable = task?.cancellable ?? false;
    const text = slow ? (minimizable ? SLOW_MINIMIZABLE_NOTE : SLOW_NOTE) : task?.description;

    return (
        <Dialog
            open={open}
            onClose={onMinimize}
            title={task?.title ?? ''}
            kicker={kicker ? <span className={styles.kicker}>{kicker}</span> : undefined}
            dismissible={minimizable}
            closeButton={false}
            width={420}
            appearDelayMs={APPEAR_DELAY_MS}
            footer={
                cancellable || minimizable ? (
                    <>
                        {cancellable && (
                            <Button variant='secondary' onClick={onCancel}>
                                Annuler
                            </Button>
                        )}
                        {minimizable && (
                            <Button icon='collapse' data-autofocus onClick={onMinimize}>
                                Réduire
                            </Button>
                        )}
                    </>
                ) : undefined
            }
        >
            {text && <p className={styles.text}>{text}</p>}
            <ProgressBar value={task?.value} label={task?.title ?? 'Opération en cours'} />
            {task?.step && <p className={styles.step}>{task.step}</p>}
        </Dialog>
    );
}

export default TaskDialog;
