import { useEffect, useRef, useState } from 'react';

import { moduleManifest } from '@/sdk/registry';
import { cancelTask, foregroundOf, hasLocalWork, minimizeTask, useTaskRecords, type TaskRecord } from '@/stores/tasks';

import { TaskDialog } from './TaskDialog';
import styles from './TaskDialog.module.css';

/** D'où vient une opération : sa fonctionnalité, puis ce qu'elle vise. */
export function taskKicker(task: Pick<TaskRecord, 'feature' | 'subject'>): string | undefined {
    const parts = [moduleManifest(task.feature)?.label, task.subject].filter(Boolean);
    return parts.length > 0 ? parts.join(' · ') : undefined;
}

const ENDING: Record<Exclude<TaskRecord['state'], 'running'>, string> = {
    done: 'terminé',
    failed: 'échec',
    lost: 'interrompue'
};

/** Ce qu'un lecteur d'écran doit apprendre d'un changement que l'œil voit dans la barre. */
function announcementOf(before: readonly TaskRecord[], now: readonly TaskRecord[]): string | null {
    const known = new Map(before.map((r) => [r.id, r]));
    for (const record of now) {
        const old = known.get(record.id);
        if (!old) continue;
        if (old.state === 'running' && record.state !== 'running') return `${record.title} : ${ENDING[record.state]}.`;
        if (!old.detached && record.detached) return `${record.title} continue en arrière-plan.`;
    }
    return null;
}

/**
 * L'hôte des opérations longues, monté une fois : le dialogue de celle qui est
 * au premier plan, l'annonce de ce qui passe en arrière-plan ou s'y termine, et
 * la garde de fermeture tant qu'un travail tourne dans l'onglet.
 */
export function TasksHost() {
    const records = useTaskRecords();
    const front = foregroundOf(records);
    const last = useRef<TaskRecord | null>(front);
    if (front) last.current = front;
    const shown = front ?? last.current;

    const [announcement, setAnnouncement] = useState('');
    const previous = useRef(records);
    useEffect(() => {
        const said = announcementOf(previous.current, records);
        previous.current = records;
        if (said !== null) setAnnouncement(said);
    }, [records]);

    const local = hasLocalWork(records);
    useEffect(() => {
        if (!local) return;
        const warn = (event: BeforeUnloadEvent): void => {
            event.preventDefault();
            // Chromium n'ouvre son invite que sur cette valeur, dépréciée ailleurs.
            event.returnValue = true;
        };
        window.addEventListener('beforeunload', warn);
        return () => window.removeEventListener('beforeunload', warn);
    }, [local]);

    return (
        <>
            <TaskDialog
                open={front !== null}
                task={shown}
                kicker={shown ? taskKicker(shown) : undefined}
                onMinimize={() => front && minimizeTask(front.id)}
                onCancel={() => front && cancelTask(front.id)}
            />
            <span className={styles.announce} role='status' aria-live='polite'>
                {announcement}
            </span>
        </>
    );
}

export default TasksHost;
