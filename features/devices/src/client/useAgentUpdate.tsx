import { openInfo } from 'deveye-sdk-client';

import { startAgentUpdate, useAgentUpdates } from './agentUpdates';

/**
 * Trigger agent self-updates from the Monitoring surfaces. In-flight state is
 * the socket-global {@link useAgentUpdates} store, so every surface spins in
 * lock-step.
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

    /**
     * Met à jour plusieurs agents, en parallèle et avec un seul message
     * d'échec : une popup par appareil en défaut serait une dizaine à fermer.
     */
    const updateAll = async (deviceIds: string[]) => {
        const results = await Promise.allSettled(deviceIds.map((id) => startAgentUpdate(id)));
        const failed = results.filter((r) => r.status === 'rejected').length;
        if (failed === 0) return;
        void openInfo({
            title: 'Mise à jour impossible',
            body: <p>{`Mise à jour impossible pour ${failed} appareil${failed > 1 ? 's' : ''}.`}</p>,
            width: 420
        });
    };

    return { update, updateAll, isBusy: isUpdating, anyBusy: anyUpdating };
}

export type AgentUpdater = ReturnType<typeof useAgentUpdate>;
