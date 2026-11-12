import { moduleManifest } from '@/sdk/registry';
import { startTeleport } from '@/stores/live';
import {
    cancelTask,
    clearFinished,
    dismissTask,
    raiseTask,
    useTaskRecords,
    zoneOf,
    type TaskRecord
} from '@/stores/tasks';
import { requestSelectWorkspace } from '@/stores/viewRequest';
import { useWorkspaceState } from '@/stores/workspace';

import { TaskRow } from './TaskRow';
import styles from './TasksStatus.module.css';

type WorkspaceState = ReturnType<typeof useWorkspaceState>;

/** L'espace où l'opération a été lancée, tel que la session le connaît encore. */
function originWorkspace(state: WorkspaceState, task: TaskRecord) {
    const { instanceId, workspaceId } = task.origin;
    if (workspaceId === null) return null;
    const list = instanceId === null ? state.workspaces : (state.remoteWorkspaces[instanceId] ?? []);
    return list.find((w) => w.id === workspaceId) ?? null;
}

/**
 * Retourner là où l'opération a été lancée. L'intention est posée avant la
 * bascule d'espace : chaque niveau la consomme à mesure qu'il se monte.
 */
function openTask(state: WorkspaceState, task: TaskRecord): void {
    const { instanceId, workspaceId } = task.origin;
    if (workspaceId === null) return;
    const path = [`view:${task.feature}`];
    if (task.itemId !== undefined) path.push(`l1:${task.itemId}`);
    startTeleport(workspaceId, path);
    if (workspaceId !== state.activeId || instanceId !== state.activeInstanceId) {
        requestSelectWorkspace(workspaceId, instanceId);
    }
}

/** Le panneau « Opérations » de la barre : celles qui tournent, puis ce qu'elles ont donné. */
export function TasksPanel({ onClose }: { onClose: () => void }) {
    const zone = zoneOf(useTaskRecords());
    const state = useWorkspaceState();

    return (
        <>
            <div className={styles.panelHead}>
                <span className={styles.panelTitle}>
                    <span className={`icon icon-operations ${styles.glyph}`} />
                    Opérations
                </span>
                {zone.some((task) => task.state !== 'running') && (
                    <button type='button' className={styles.rowAction} onClick={clearFinished}>
                        Tout effacer
                    </button>
                )}
            </div>
            <div className={styles.rows}>
                {zone.map((task) => {
                    const manifest = moduleManifest(task.feature);
                    const workspace = originWorkspace(state, task);
                    const here =
                        task.origin.workspaceId === state.activeId && task.origin.instanceId === state.activeInstanceId;
                    return (
                        <TaskRow
                            key={task.id}
                            task={task}
                            feature={manifest ? { label: manifest.label, icon: manifest.icon } : null}
                            workspaceName={here ? null : (workspace?.name ?? 'Autre espace')}
                            onShow={() => {
                                raiseTask(task.id);
                                onClose();
                            }}
                            onCancel={() => cancelTask(task.id)}
                            onOpen={
                                manifest && workspace
                                    ? () => {
                                          openTask(state, task);
                                          onClose();
                                      }
                                    : null
                            }
                            onDismiss={() => dismissTask(task.id)}
                        />
                    );
                })}
            </div>
        </>
    );
}

export default TasksPanel;
