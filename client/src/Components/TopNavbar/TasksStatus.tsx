import { AnimatePresence, motion } from 'framer-motion';
import { useId, useLayoutEffect, useRef, useState } from 'react';

import { chipOf, useTaskRecords } from '@/stores/tasks';

import { TaskChip } from './TaskChip';
import { TasksPanel } from './TasksPanel';
import styles from './TasksStatus.module.css';
import bar from './TopNavbar.module.css';

export interface TasksStatusProps {
    open: boolean;
    onToggle: () => void;
    onClose: () => void;
}

/** La gouttière que le panneau garde avec le bord de l'écran : celle que retient sa largeur (`--space-md`). */
const EDGE = 16;

/**
 * La zone des opérations de la barre : sa puce, et le panneau qu'elle ouvre.
 * Elle n'existe que lorsqu'une opération réduite tourne ou qu'un résultat
 * attend d'être vu, et reste hors du catalogue des widgets : elle est à la
 * personne, pas à l'espace.
 */
export function TasksStatus({ open, onToggle, onClose }: TasksStatusProps) {
    const chip = chipOf(useTaskRecords());
    const panelId = useId();
    const zone = useRef<HTMLDivElement>(null);
    const panel = useRef<HTMLDivElement>(null);
    const [shift, setShift] = useState(0);

    // Le panneau s'ouvre sous la puce, bord gauche contre bord gauche. Là où il
    // sortirait de l'écran, il se décale juste assez ; la puce change de
    // largeur et de place pendant qu'il est ouvert (une opération se termine).
    useLayoutEffect(() => {
        const anchor = zone.current;
        if (!open || !anchor) return;
        const place = (): void => {
            const { left } = anchor.getBoundingClientRect();
            const width = panel.current?.offsetWidth ?? 0;
            setShift(Math.max(EDGE, Math.min(left, window.innerWidth - width - EDGE)) - left);
        };
        place();
        const observer = new ResizeObserver(place);
        observer.observe(anchor);
        window.addEventListener('resize', place);
        return () => {
            observer.disconnect();
            window.removeEventListener('resize', place);
        };
    }, [open]);

    return (
        <AnimatePresence>
            {chip && (
                <motion.div
                    ref={zone}
                    className={styles.zone}
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.9 }}
                    transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                >
                    <TaskChip chip={chip} open={open} panelId={panelId} onClick={onToggle} />
                    <AnimatePresence>
                        {open && (
                            <motion.div
                                ref={panel}
                                id={panelId}
                                role='dialog'
                                aria-label='Opérations'
                                className={`${bar.menu} ${bar.tasksMenu}`}
                                style={{ left: shift }}
                                initial={{ opacity: 0, y: 0 }}
                                animate={{ opacity: 1, y: 8 }}
                                exit={{ opacity: 0, y: 0 }}
                                transition={{ duration: 0.15 }}
                            >
                                <TasksPanel onClose={onClose} />
                            </motion.div>
                        )}
                    </AnimatePresence>
                </motion.div>
            )}
        </AnimatePresence>
    );
}

export default TasksStatus;
