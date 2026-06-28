import { openInfo } from '@/Components/InfoPopup';
import { startAgentUpdate, useAgentUpdates } from '@/stores/agentUpdates';

/**
 * Trigger signed agent self-updates for the Monitoring surfaces (panel header,
 * sidebar per-device button, "update all"). In-flight state is backed by the
 * socket-global {@link useAgentUpdates} store, so every surface — here and the
 * Appareils card — spins in lock-step for the whole update, not just while the
 * order is sent.
 */
export function useAgentUpdate() {
    const { isUpdating, anyUpdating } = useAgentUpdates();

    const update = async (deviceId: string) => {
        try {
            await startAgentUpdate(deviceId);
        } catch (e) {
            void openInfo({
                title: 'Mise à jour impossible',
                body: <p>{e instanceof Error ? e.message : 'Échec de la mise à jour de l’agent.'}</p>,
                width: 420
            });
        }
    };

    /** Update several agents sequentially (used by "tout mettre à jour"). */
    const updateAll = async (deviceIds: string[]) => {
        for (const id of deviceIds) await update(id);
    };

    return { update, updateAll, isBusy: isUpdating, anyBusy: anyUpdating };
}

export type AgentUpdater = ReturnType<typeof useAgentUpdate>;
