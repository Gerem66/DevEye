import { useState } from 'react';
import { ws } from '@/api/ws';
import { openInfo } from '@/Components/InfoPopup';
import styles from './Clients.module.css';

type Target = { id: string; name: string } | null;

/**
 * All device-management actions for the Appareils page (approve/revoke/rename,
 * self-update, persistence & privileges, deletion), with their in-flight state.
 * Returned as one object so `DeviceCard` and the dialogs share it.
 */
export function useDeviceActions(refresh: () => Promise<void> | void) {
    const [actionError, setActionError] = useState<string | null>(null);
    const [updatingId, setUpdatingId] = useState<string | null>(null);
    const [serviceBusyId, setServiceBusyId] = useState<string | null>(null);
    // Dialog targets (the confirmation dialogs live in the page).
    const [deleteTarget, setDeleteTarget] = useState<Target>(null);
    const [deleting, setDeleting] = useState(false);
    const [forceTarget, setForceTarget] = useState<Target>(null);
    const [forcing, setForcing] = useState(false);
    const [renameTarget, setRenameTarget] = useState<Target>(null);
    const [renameValue, setRenameValue] = useState('');
    const [renaming, setRenaming] = useState(false);
    const [packagesTarget, setPackagesTarget] = useState<Target>(null);

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
            await ws.send('device.updateAgent', { deviceId: id });
            // The agent verifies, swaps its binary and restarts; it reconnects with
            // its new version shortly. Refresh now and once more after a beat so the
            // card reflects the new version without the user reopening the page.
            await refresh();
            setTimeout(() => void refresh(), 4000);
        } catch (e) {
            // Surface the server's reason (offline, already up to date, unsigned…).
            setActionError(e instanceof Error ? e.message : "Mise à jour de l'agent impossible.");
        } finally {
            setUpdatingId(null);
        }
    };

    const setAutostart = async (id: string, enabled: boolean) => {
        setActionError(null);
        setServiceBusyId(id);
        try {
            await ws.send('device.setAutostart', { deviceId: id, enabled });
            await refresh();
            // The agent reports its new service scope on its next report.
            setTimeout(() => void refresh(), 3000);
        } catch (e) {
            setActionError(e instanceof Error ? e.message : 'Action impossible.');
        } finally {
            setServiceBusyId(null);
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

    const elevateDevice = async (id: string) => {
        setActionError(null);
        setServiceBusyId(id);
        try {
            const res = await ws.send('device.elevate', { deviceId: id });
            showManualCommand('Élever l’agent en root', res.manualCommand);
            await refresh();
            setTimeout(() => void refresh(), 4000);
        } catch (e) {
            setActionError(e instanceof Error ? e.message : 'Élévation impossible.');
        } finally {
            setServiceBusyId(null);
        }
    };

    const dropPrivilegesDevice = async (id: string) => {
        setActionError(null);
        setServiceBusyId(id);
        try {
            const res = await ws.send('device.dropPrivileges', { deviceId: id });
            showManualCommand('Rétrograder l’agent', res.manualCommand);
            await refresh();
            setTimeout(() => void refresh(), 4000);
        } catch (e) {
            setActionError(e instanceof Error ? e.message : 'Rétrogradation impossible.');
        } finally {
            setServiceBusyId(null);
        }
    };

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
        serviceBusyId,
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
        packagesTarget,
        setPackagesTarget,
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
