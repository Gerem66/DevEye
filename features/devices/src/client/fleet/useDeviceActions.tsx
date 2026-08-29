import { useRef, useState } from 'react';
import { DEVICE_SERVICE_EVENT, deviceServicePushSchema, type DeviceServicePush } from '@deveye/types';
import { acquireMetrics, onServerEvent, openInfo } from 'deveye-sdk-client';

import { startAgentUpdate, useAgentUpdates } from '../agentUpdates';
import { agent, api } from '../api';
import styles from './style.module.css';

type Target = { id: string; name: string } | null;

/** Ce qu'une action de service a donné *sur l'appareil*, affiché sur sa carte. */
export type DeviceNote = { id: string; tone: 'ok' | 'error'; message: string };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Délai au-delà duquel on cesse d'attendre le verdict de l'agent. Large (une
 * élévation attend une autorisation humaine sur la machine) mais fini :
 * « l'agent n'a pas répondu » est une réponse.
 */
const SERVICE_RESULT_TIMEOUT = 20_000;

/**
 * Attend le résultat que l'agent renvoie pour l'action en cours, ou `null` au
 * bout de {@link SERVICE_RESULT_TIMEOUT}. L'abonnement est pris AVANT l'envoi :
 * l'agent peut répondre en quelques dizaines de millisecondes.
 */
function awaitServiceResult(deviceId: string): {
    result: Promise<DeviceServicePush | null>;
    /** Abandon immédiat (la commande n'est jamais partie) : libère l'abonnement. */
    cancel: () => void;
} {
    let finish: (value: DeviceServicePush | null) => void = () => {};
    const result = new Promise<DeviceServicePush | null>((resolve) => {
        const release = acquireMetrics(deviceId);
        let settled = false;
        finish = (value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            off();
            release();
            resolve(value);
        };
        const off = onServerEvent(DEVICE_SERVICE_EVENT, deviceServicePushSchema, (data) => {
            if (data.deviceId === deviceId) finish(data);
        });
        const timer = setTimeout(() => finish(null), SERVICE_RESULT_TIMEOUT);
    });
    return { result, cancel: () => finish(null) };
}

/**
 * All device-management actions for the fleet segment, with their in-flight
 * state, as one object shared by `DeviceCard` and the dialogs.
 */
export function useDeviceActions(refresh: () => Promise<void> | void) {
    // Refresh, wait for the agent to re-report its scope, refresh again: a
    // toggle only settles on the confirmed state, never the requested one.
    const settle = async (ms: number) => {
        await refresh();
        await sleep(ms);
        await refresh();
    };
    const [actionError, setActionError] = useState<string | null>(null);
    // Socket-global, so the card spins in lock-step with the Monitoring surfaces.
    const { isUpdating } = useAgentUpdates();
    // Which toggle (per device) is mid-change, so only that one shows a loader.
    const [serviceBusy, setServiceBusy] = useState<{ id: string; kind: 'autostart' | 'privilege' } | null>(null);
    // Verdict de la dernière action de service, sur la carte visée : le bandeau
    // d'erreur de la page est trop loin de la dixième carte.
    const [deviceNote, setDeviceNote] = useState<DeviceNote | null>(null);
    const noteTimer = useRef<number | null>(null);
    /**
     * Pose le verdict. Une réussite s'efface d'elle-même (l'état confirmé est
     * lisible sur les bascules) ; un échec reste, seule trace de ce qui s'est
     * passé sur la machine.
     */
    const showNote = (note: DeviceNote | null) => {
        if (noteTimer.current !== null) window.clearTimeout(noteTimer.current);
        noteTimer.current = null;
        setDeviceNote(note);
        if (note?.tone === 'ok') {
            noteTimer.current = window.setTimeout(() => {
                setDeviceNote((current) => (current === note ? null : current));
            }, 8000);
        }
    };
    // Dialog targets (the confirmation dialogs live in the page).
    const [deleteTarget, setDeleteTarget] = useState<Target>(null);
    const [deleting, setDeleting] = useState(false);
    const [forceTarget, setForceTarget] = useState<Target>(null);
    const [forcing, setForcing] = useState(false);
    const [renameTarget, setRenameTarget] = useState<Target>(null);
    const [renameValue, setRenameValue] = useState('');
    const [renaming, setRenaming] = useState(false);
    // Stopping goes through a confirmation dialog (the consequences depend on
    // autostart); restarting runs directly.
    const [stopTarget, setStopTarget] = useState<Target>(null);
    const [stopping, setStopping] = useState(false);
    const [restartingId, setRestartingId] = useState<string | null>(null);
    // La popup de partage charge et enregistre elle-même.
    const [shareTarget, setShareTarget] = useState<Target>(null);

    const confirmDevice = async (id: string) => {
        setActionError(null);
        try {
            await api.send('devices.confirm', { deviceId: id });
            await refresh();
        } catch {
            setActionError('Approbation impossible.');
        }
    };

    const revokeDevice = async (id: string) => {
        setActionError(null);
        try {
            await api.send('devices.revoke', { deviceId: id });
            await refresh();
        } catch {
            setActionError('Révocation impossible.');
        }
    };

    const reactivateDevice = async (id: string) => {
        setActionError(null);
        try {
            await api.send('devices.reactivate', { deviceId: id });
            await refresh();
        } catch {
            setActionError('Réactivation impossible.');
        }
    };

    const updateAgent = async (id: string) => {
        setActionError(null);
        try {
            await startAgentUpdate(id);
        } catch (e) {
            // Surface the server's reason (offline, already up to date, unsigned…).
            setActionError(e instanceof Error ? e.message : "Mise à jour de l'agent impossible.");
        }
    };

    /** Push a self-update to several agents at once (the "Tout mettre à jour" button). */
    const updateAllAgents = async (ids: string[]) => {
        setActionError(null);
        const results = await Promise.allSettled(ids.map((id) => startAgentUpdate(id)));
        const failed = results.filter((r) => r.status === 'rejected').length;
        if (failed > 0) {
            setActionError(`Mise à jour impossible pour ${failed} appareil${failed > 1 ? 's' : ''}.`);
        }
    };

    const setAutostart = async (id: string, enabled: boolean) => {
        setActionError(null);
        showNote(null);
        setServiceBusy({ id, kind: 'autostart' });
        // Abonné avant d'envoyer (voir `awaitServiceResult`).
        const verdict = awaitServiceResult(id);
        try {
            await agent.send('agent.setAutostart', { deviceId: id, enabled });
        } catch (e) {
            verdict.cancel();
            setServiceBusy(null);
            const message = e instanceof Error ? e.message : 'Action impossible.';
            setActionError(message);
            showNote({ id, tone: 'error', message });
            return;
        }
        const result = await verdict.result;
        if (result === null) {
            showNote({
                id,
                tone: 'error',
                message: 'L’agent n’a pas répondu ; la modification n’est pas confirmée.'
            });
        } else if (!result.ok) {
            showNote({ id, tone: 'error', message: result.error ?? 'L’appareil a refusé la modification.' });
        } else {
            showNote({
                id,
                tone: 'ok',
                message: enabled
                    ? 'Démarrage auto activé : l’agent est relancé sous le service.'
                    : 'Démarrage auto désactivé.'
            });
        }
        // Après une activation l'agent redémarre sous le service : on lui laisse
        // le temps de se reconnecter avant de relire sa portée.
        await settle(3000);
        setServiceBusy(null);
    };

    // The guided fallback command: if no OS prompt appears on the device, the
    // user runs this.
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
     * Elevate / drop privileges, like the autostart toggle: a loader runs until
     * the agent has said what happened. C'est l'agent qui tranche : il annonce
     * `needsManualCommand` quand aucune session interactive ne lui permet
     * d'ouvrir la fenêtre d'autorisation.
     */
    const changePrivilege = async (
        id: string,
        command: 'agent.elevate' | 'agent.dropPrivileges',
        title: string,
        successLabel: string,
        errorLabel: string
    ) => {
        setActionError(null);
        showNote(null);
        setServiceBusy({ id, kind: 'privilege' });
        const verdict = awaitServiceResult(id);
        let manual: string;
        try {
            manual = (await agent.send(command, { deviceId: id })).manualCommand;
        } catch (e) {
            verdict.cancel();
            setServiceBusy(null);
            const message = e instanceof Error ? e.message : errorLabel;
            setActionError(message);
            showNote({ id, tone: 'error', message });
            return;
        }
        const result = await verdict.result;
        if (result === null) {
            showNote({ id, tone: 'error', message: "L’agent n’a pas répondu ; rien n'est confirmé." });
        } else if (result.needsManualCommand) {
            showNote({ id, tone: 'error', message: 'À autoriser sur l’appareil — commande affichée.' });
            showManualCommand(title, manual);
        } else if (!result.ok) {
            showNote({ id, tone: 'error', message: result.error ?? errorLabel });
        } else {
            showNote({ id, tone: 'ok', message: successLabel });
        }
        await settle(4000);
        setServiceBusy(null);
    };

    const elevateDevice = (id: string) =>
        changePrivilege(
            id,
            'agent.elevate',
            'Élever l’agent en root',
            'Agent élevé en service système (root).',
            'Élévation impossible.'
        );

    const dropPrivilegesDevice = (id: string) =>
        changePrivilege(
            id,
            'agent.dropPrivileges',
            'Rétrograder l’agent',
            'Agent rétrogradé en service utilisateur.',
            'Rétrogradation impossible.'
        );

    /** Stop the agent process (confirmed via the explanatory dialog). */
    const confirmStopAgent = async () => {
        if (!stopTarget) return;
        setActionError(null);
        setStopping(true);
        try {
            await agent.send('agent.lifecycle', { deviceId: stopTarget.id, action: 'stop' });
            setStopTarget(null);
            // Presence pushes flip the card; refresh for the rest.
            await settle(2000);
        } catch (e) {
            setActionError(e instanceof Error ? e.message : 'Interruption impossible.');
        } finally {
            setStopping(false);
        }
    };

    /** Cleanly restart the agent process (offline for a few seconds, then back). */
    const restartAgent = async (id: string) => {
        setActionError(null);
        setRestartingId(id);
        try {
            await agent.send('agent.lifecycle', { deviceId: id, action: 'restart' });
            // Keep the spinner through the offline→online round trip.
            await settle(4000);
        } catch (e) {
            setActionError(e instanceof Error ? e.message : 'Redémarrage impossible.');
        } finally {
            setRestartingId(null);
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
            await api.send('devices.rename', { deviceId: renameTarget.id, name });
            setRenameTarget(null);
            await refresh();
        } catch {
            setActionError('Renommage impossible.');
        } finally {
            setRenaming(false);
        }
    };

    // Managed deletion: the agent self-destructs, then the device is archived.
    const confirmRemoveDevice = async () => {
        if (!deleteTarget) return;
        setActionError(null);
        setDeleting(true);
        try {
            await api.send('devices.requestDelete', { deviceId: deleteTarget.id });
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
            await api.send('devices.cancelDelete', { deviceId: id });
            await refresh();
        } catch {
            setActionError('Annulation impossible.');
        }
    };

    // Archive now without waiting for the agent to self-destruct.
    const confirmForceDelete = async () => {
        if (!forceTarget) return;
        setActionError(null);
        setForcing(true);
        try {
            await api.send('devices.forceDelete', { deviceId: forceTarget.id });
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
        isUpdating,
        serviceBusy,
        deviceNote,
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
        stopTarget,
        setStopTarget,
        stopping,
        shareTarget,
        setShareTarget,
        confirmStopAgent,
        restartAgent,
        restartingId,
        confirmDevice,
        revokeDevice,
        reactivateDevice,
        updateAgent,
        updateAllAgents,
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
