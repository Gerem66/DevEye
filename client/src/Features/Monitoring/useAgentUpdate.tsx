import { useState } from 'react';
import { ws } from '@/api/ws';
import { openInfo } from '@/Components/InfoPopup';
import { useDevices } from '@/stores/devices';

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
            await ws.send('device.updateAgent', { deviceId });
            // The agent verifies, swaps its binary and reconnects with the new
            // version shortly; refresh now and once more after a beat.
            await refresh();
            setTimeout(() => void refresh(), 4000);
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
