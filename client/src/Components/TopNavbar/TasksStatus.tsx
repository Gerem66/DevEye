import { AnimatePresence, motion } from 'framer-motion';

import { chipOf, useTaskRecords } from '@/stores/tasks';

import { TaskChip } from './TaskChip';
import styles from './TasksStatus.module.css';

export interface TasksStatusProps {
    open: boolean;
    panelId: string;
    onToggle: () => void;
}

/**
 * La zone des opérations de la barre. Elle n'existe que lorsqu'une opération
 * réduite tourne ou qu'un résultat attend d'être vu, et reste hors du
 * catalogue des widgets : elle est à la personne, pas à l'espace.
 */
export function TasksStatus({ open, panelId, onToggle }: TasksStatusProps) {
    const chip = chipOf(useTaskRecords());
    return (
        <AnimatePresence>
            {chip && (
                <motion.span
                    className={styles.zone}
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.9 }}
                    transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                >
                    <TaskChip chip={chip} open={open} panelId={panelId} onClick={onToggle} />
                </motion.span>
            )}
        </AnimatePresence>
    );
}

export default TasksStatus;
