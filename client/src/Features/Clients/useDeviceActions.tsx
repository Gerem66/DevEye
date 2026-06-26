import { useRef, useState } from 'react';
import type { Device } from 'deveye-types';
import { ws } from '@/api/ws';
import { openInfo } from '@/Components/InfoPopup';
import { runAgentUpdate } from '../agentUpdate';
import styles from './Clients.module.css';

type Target = { id: string; name: string } | null;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * All device-management actions for the Appareils page (approve/revoke/rename,
 * self-update, persistence & privileges, deletion), with their in-flight state.
 * Returned as one object so `DeviceCard` and the dialogs share it.
 */
export function useDeviceActions(devices: Device[], refresh: () => Promise<void> | void) {
    // Live device list read inside async handlers, to tell once a privilege change
    // has actually been confirmed by the agent's next report.
    const devicesRef = useRef(devices);
    devicesRef.current = devices;

    // Refresh now, wait for the agent to apply the change and re-report its scope,
    // then refresh again — so a toggle/privilege only settles on the *confirmed*
    // state, never the merely-requested one. Shared by the service actions below.
    const settle = async (ms: number) => {
        await refresh();
        await sleep(ms);
        await refresh();
    };
    const [actionError, setActionError] = useState<string | null>(null);
    const [updatingId, setUpdatingId] = useState<string | null>(null);
    // Which toggle (per device) is mid-change, so only that one shows a loader.
    const [serviceBusy, setServiceBusy] = useState<{ id: string; kind: 'autostart' | 'privilege' } | null>(null);
    // Dialog targets (the confirmation dialogs live in the page).
    const [deleteTarget, setDeleteTarget] = useState<Target>(null);
    const [deleting, setDeleting] = useState(false);
    const [forceTarget, setForceTarget] = useState<Target>(null);
    const [forcing, setForcing] = useState(false);
    const [renameTarget, setRenameTarget] = useState<Target>(null);
    const [renameValue, setRenameValue] = useState('');
    const [renaming, setRenaming] = useState(false);

    const confirmDevice = async (id: string) => {
        setActionError(null);
        try {
            await ws.send('device.confirm', { deviceId: id });
            await refresh();
        } catch {
            setActionError('Approbation impossible.');
        }
    };

    const revokeDevice = async (id: string) => {
        setActionError(null);
        try {
            await ws.send('device.revoke', { deviceId: id });
            await refresh();
        } catch {
            setActionError('Révocation impossible.');
        }
    };

    const reactivateDevice = async (id: string) => {
        setActionError(null);
        try {
            await ws.send('device.reactivate', { deviceId: id });
            await refresh();
        } catch {
            setActionError('Réactivation impossible.');
        }
    };

    const updateAgent = async (id: string) => {
        setActionError(null);
        setUpdatingId(id);
        try {
            await runAgentUpdate(id, refresh);
        } catch (e) {
            // Surface the server's reason (offline, already up to date, unsigned…).
            setActionError(e instanceof Error ? e.message : "Mise à jour de l'agent impossible.");
        } finally {
            setUpdatingId(null);
        }
    };

    const setAutostart = async (id: string, enabled: boolean) => {
        setActionError(null);
        setServiceBusy({ id, kind: 'autostart' });
        try {
            await ws.send('device.setAutostart', { deviceId: id, enabled });
            // Keep the loader on until the agent has applied the change and
            // re-reported its scope, so the toggle only flips once it's confirmed.
            await settle(3000);
        } catch (e) {
            setActionError(e instanceof Error ? e.message : 'Action impossible.');
        } finally {
            setServiceBusy(null);
        }
    };

    // Show the guided fallback command (hybrid elevation): if no OS prompt appears
    // on the device, the user runs this. The change confirms via the next report.
    const showManualCommand = (title: string, command: string) =>
        void openInfo({
            title,
            width: 520,
            body: (
                <div className={styles.manualCommandBox}>
                    <p>
                        Une fenêtre d’autorisation devrait apparaître sur l’appareil. Si rien ne s’affiche, exécutez-y :
                    </p>
                    <code className={styles.manualCommand}>{command}</code>
                </div>
            )
        });

    /**
     * Elevate / drop privileges — behaves exactly like the autostart toggle: a
     * loader runs until the change is confirmed by the agent's next report. The
     * agent restarts under the new scope, so we wait, refresh, then check the
     * reported scope. Only if it *didn't* reach the target (no interactive session
     * on the device → hybrid elevation) do we surface the manual command to run there.
     */
    const changePrivilege = async (
        id: string,
        command: 'device.elevate' | 'device.dropPrivileges',
        title: string,
        reached: (scope: string) => boolean,
        errorLabel: string
    ) => {
        setActionError(null);
        setServiceBusy({ id, kind: 'privilege' });
        try {
            const res = await ws.send(command, { deviceId: id });
            await settle(4000);
            const scope = devicesRef.current.find((d) => d.id === id)?.report?.agent?.serviceScope ?? 'none';
            if (!reached(scope)) showManualCommand(title, res.manualCommand);
        } catch (e) {
            setActionError(e instanceof Error ? e.message : errorLabel);
        } finally {
            setServiceBusy(null);
        }
    };

    const elevateDevice = (id: string) =>
        changePrivilege(
            id,
            'device.elevate',
            'Élever l’agent en root',
            (scope) => scope === 'system',
            'Élévation impossible.'
        );

    const dropPrivilegesDevice = (id: string) =>
        changePrivilege(
            id,
            'device.dropPrivileges',
            'Rétrograder l’agent',
            (scope) => scope !== 'system',
            'Rétrogradation impossible.'
        );

    const openRename = (id: string, current: string) => {
        setActionError(null);
        setRenameValue(current);
        setRenameTarget({ id, name: current });
    };

    const confirmRename = async () => {
        if (!renameTarget) return;
        const name = renameValue.trim();
        if (!name || name === renameTarget.name) {
            setRenameTarget(null);
            return;
        }
        setRenaming(true);
        setActionError(null);
        try {
            await ws.send('device.rename', { deviceId: renameTarget.id, name });
            setRenameTarget(null);
            await refresh();
        } catch {
            setActionError('Renommage impossible.');
        } finally {
            setRenaming(false);
        }
    };

    // Managed deletion: ask the agent to self-destruct, then archive (keeping the
    // monitoring history). Confirmed via the explanatory dialog.
    const confirmRemoveDevice = async () => {
        if (!deleteTarget) return;
        setActionError(null);
        setDeleting(true);
        try {
            await ws.send('device.requestDelete', { deviceId: deleteTarget.id });
            setDeleteTarget(null);
            await refresh();
        } catch {
            setActionError('Suppression impossible.');
            void refresh();
        } finally {
            setDeleting(false);
        }
    };

    const cancelDeleteDevice = async (id: string) => {
        setActionError(null);
        try {
            await ws.send('device.cancelDelete', { deviceId: id });
            await refresh();
        } catch {
            setActionError('Annulation impossible.');
        }
    };

    // Force the deletion now (archive) without waiting for the agent to self-destruct.
    const confirmForceDelete = async () => {
        if (!forceTarget) return;
        setActionError(null);
        setForcing(true);
        try {
            await ws.send('device.forceDelete', { deviceId: forceTarget.id });
            setForceTarget(null);
            await refresh();
        } catch {
            setActionError('Suppression impossible.');
        } finally {
            setForcing(false);
        }
    };

    return {
        actionError,
        updatingId,
        serviceBusy,
        deleteTarget,
        setDeleteTarget,
        deleting,
        forceTarget,
        setForceTarget,
        forcing,
        renameTarget,
        setRenameTarget,
        renameValue,
        setRenameValue,
        renaming,
        confirmDevice,
        revokeDevice,
        reactivateDevice,
        updateAgent,
        setAutostart,
        elevateDevice,
        dropPrivilegesDevice,
        openRename,
        confirmRename,
        confirmRemoveDevice,
        cancelDeleteDevice,
        confirmForceDelete
    };
}

export type DeviceActions = ReturnType<typeof useDeviceActions>;
