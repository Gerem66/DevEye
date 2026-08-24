import { useRef, useState } from 'react';
import { DEVICE_SERVICE_EVENT, type DeviceServicePush } from '@deveye/types';
import { ws } from '@/api/ws';
import { openInfo } from '@/Components/InfoPopup';
import { startAgentUpdate, useAgentUpdates } from '@/stores/agentUpdates';
import { acquireMetrics } from '@/stores/metricsSubscription';
import styles from './Clients.module.css';

type Target = { id: string; name: string } | null;

/** Ce qu'une action de service a donné *sur l'appareil*, affiché sur sa carte. */
export type DeviceNote = { id: string; tone: 'ok' | 'error'; message: string };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Délai au-delà duquel on cesse d'attendre le verdict de l'agent.
 *
 * Une installation de service enchaîne plusieurs commandes système (`systemctl`,
 * `launchctl`, `loginctl`), et une élévation attend une autorisation humaine sur
 * la machine. Large, donc — mais fini : « l'agent n'a pas répondu » est une
 * réponse, l'attente muette n'en est pas une.
 */
const SERVICE_RESULT_TIMEOUT = 20_000;

/**
 * Attend le résultat que l'agent renvoie pour l'action en cours, ou `null` au
 * bout de {@link SERVICE_RESULT_TIMEOUT}.
 *
 * L'abonnement est pris **avant** l'envoi de la commande : l'agent peut répondre
 * en quelques dizaines de millisecondes, et un abonnement pris après coup
 * manquerait la réponse — l'échec redeviendrait silencieux.
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
        const off = ws.onMessage((msg) => {
            if (msg.command !== DEVICE_SERVICE_EVENT || !msg.payload.ok) return;
            const data = msg.payload.data as DeviceServicePush;
            if (data.deviceId === deviceId) finish(data);
        });
        const timer = setTimeout(() => finish(null), SERVICE_RESULT_TIMEOUT);
    });
    return { result, cancel: () => finish(null) };
}

/**
 * All device-management actions for the Appareils page (approve/revoke/rename,
 * self-update, persistence & privileges, deletion), with their in-flight state.
 * Returned as one object so `DeviceCard` and the dialogs share it.
 */
export function useDeviceActions(refresh: () => Promise<void> | void) {
    // Refresh now, wait for the agent to apply the change and re-report its scope,
    // then refresh again — so a toggle/privilege only settles on the *confirmed*
    // state, never the merely-requested one. Shared by the service actions below.
    const settle = async (ms: number) => {
        await refresh();
        await sleep(ms);
        await refresh();
    };
    const [actionError, setActionError] = useState<string | null>(null);
    // In-flight self-updates live in the socket-global store so this card spins in
    // lock-step with the Monitoring surfaces, for the whole update (not just the order).
    const { isUpdating } = useAgentUpdates();
    // Which toggle (per device) is mid-change, so only that one shows a loader.
    const [serviceBusy, setServiceBusy] = useState<{ id: string; kind: 'autostart' | 'privilege' } | null>(null);
    // Verdict de la dernière action de service, affiché **sur la carte visée**.
    // Le bandeau d'erreur de la page vit tout en haut : sur une flotte, celui qui
    // clique sur la dixième carte ne le voit jamais.
    const [deviceNote, setDeviceNote] = useState<DeviceNote | null>(null);
    const noteTimer = useRef<number | null>(null);
    /**
     * Pose le verdict. Une réussite s'efface d'elle-même — l'état confirmé est
     * déjà lisible sur les bascules ; un échec reste, parce qu'il est la seule
     * trace de ce qui s'est passé sur la machine.
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
    // Agent process lifecycle: stopping goes through a confirmation dialog (the
    // consequences depend on autostart); restarting runs directly with a spinner.
    const [stopTarget, setStopTarget] = useState<Target>(null);
    const [stopping, setStopping] = useState(false);
    const [restartingId, setRestartingId] = useState<string | null>(null);
    // Partage entre espaces : la popup charge et enregistre elle-même, on ne
    // retient ici que l'appareil visé.
    const [shareTarget, setShareTarget] = useState<Target>(null);

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
            await ws.send('device.setAutostart', { deviceId: id, enabled });
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
        // La bascule ne se fie qu'à la portée *re-rapportée* par l'agent : après
        // une activation il redémarre sous le service, on lui laisse le temps de
        // se reconnecter avant de relire.
        await settle(3000);
        setServiceBusy(null);
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
     * loader runs until the agent has said what happened.
     *
     * C'est l'agent qui tranche, et non plus une déduction : il annonce
     * lui-même `needsManualCommand` quand aucune session interactive ne lui
     * permet d'ouvrir la fenêtre d'autorisation. On lisait auparavant la portée
     * re-rapportée quatre secondes plus tard, ce qui confondait « l'appareil a
     * besoin de toi » avec « ça a échoué » — et, l'agent redémarrant sous sa
     * nouvelle portée, avec « le rapport n'est pas encore arrivé ».
     */
    const changePrivilege = async (
        id: string,
        command: 'device.elevate' | 'device.dropPrivileges',
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
            manual = (await ws.send(command, { deviceId: id })).manualCommand;
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
            'device.elevate',
            'Élever l’agent en root',
            'Agent élevé en service système (root).',
            'Élévation impossible.'
        );

    const dropPrivilegesDevice = (id: string) =>
        changePrivilege(
            id,
            'device.dropPrivileges',
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
            await ws.send('device.agentLifecycle', { deviceId: stopTarget.id, action: 'stop' });
            setStopTarget(null);
            // Presence pushes flip the card, but refresh anyway for the rest.
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
            await ws.send('device.agentLifecycle', { deviceId: id, action: 'restart' });
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
