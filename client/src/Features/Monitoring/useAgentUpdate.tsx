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

    /**
     * Met à jour plusieurs agents (le bouton « tout mettre à jour »).
     *
     * En parallèle, et **un seul** message d'échec : la boucle séquentielle
     * d'origine ouvrait une popup bloquante par appareil en défaut — sur une
     * flotte qui vient de repartir, c'était une dizaine de popups à fermer une
     * par une. Même comportement que la page Appareils, qui procédait déjà ainsi.
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
