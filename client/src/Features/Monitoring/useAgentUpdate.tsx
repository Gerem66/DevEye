import { useState } from 'react';
import { openInfo } from '@/Components/InfoPopup';
import { useDevices } from '@/stores/devices';
import { runAgentUpdate } from '../agentUpdate';

/**
 * Trigger signed agent self-updates with per-device in-flight state. Shared by
 * every Monitoring surface that offers an update (panel header, sidebar per-device
 * button, "update all"), so the behaviour stays consistent.
 */
export function useAgentUpdate() {
    const { refresh } = useDevices();
    const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());

    const update = async (deviceId: string) => {
        setBusy((s) => new Set(s).add(deviceId));
        try {
            await runAgentUpdate(deviceId, refresh);
        } catch (e) {
            void openInfo({
                title: 'Mise à jour impossible',
                body: <p>{e instanceof Error ? e.message : 'Échec de la mise à jour de l’agent.'}</p>,
                width: 420
            });
        } finally {
            setBusy((s) => {
                const next = new Set(s);
                next.delete(deviceId);
                return next;
            });
        }
    };

    /** Update several agents sequentially (used by "tout mettre à jour"). */
    const updateAll = async (deviceIds: string[]) => {
        for (const id of deviceIds) await update(id);
    };

    return { update, updateAll, isBusy: (id: string) => busy.has(id), anyBusy: busy.size > 0 };
}

export type AgentUpdater = ReturnType<typeof useAgentUpdate>;
