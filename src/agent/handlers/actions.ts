import { AGENT_DESTROYED, AGENT_POWER_RESULT, AGENT_SERVICE_RESULT, AGENT_UPDATED } from '@deveye/types';

import { ack, type AgentSession, type PayloadOf } from './session';

/** French label per power action, for human-readable audit descriptions. */
const POWER_LABELS: Record<string, string> = {
    shutdown: 'Extinction',
    reboot: 'Redémarrage',
    suspend: 'Mise en veille',
    hibernate: 'Veille prolongée',
    lock: 'Verrouillage'
};

/**
 * Outcomes of the commands the server pushes to an agent (`agent.update`,
 * `agent.destroy`, `agent.service`). The agent applies them on-device and reports
 * back here; the server records the result (and, for self-destruct, archives the
 * device). The *effective* state comes back on the next `agent.report` — these
 * handlers only audit.
 */

/** `agent.updated` — result of a self-update. On success the agent restarts and
 *  reconnects with its new version (via `agent.hello`); we just audit here. */
export async function handleUpdated(s: AgentSession, payload: PayloadOf<typeof AGENT_UPDATED>): Promise<void> {
    const { ok, version, error } = payload;
    s.audit.record({
        source: 'agent',
        category: 'device',
        action: ok ? 'device.agentUpdated' : 'device.agentUpdateFailed',
        level: ok ? 'info' : 'error',
        uid: s.ownerId,
        ip: s.ip,
        description: ok
            ? `Agent mis à jour : « ${s.device.name} »${version ? ` → ${version}` : ''}`
            : `Échec de la mise à jour de l'agent : « ${s.device.name} » — ${error ?? 'raison inconnue'}`,
        metadata: { deviceId: s.device.id, version: version ?? null, error: error ?? null }
    });
    ack(s, 1);
}

/** `agent.destroyed` — result of a self-destruct. Archive the device on success,
 *  else record the failure (which restores its previous status). */
export async function handleDestroyed(s: AgentSession, payload: PayloadOf<typeof AGENT_DESTROYED>): Promise<void> {
    if (payload.ok) {
        try {
            await s.db.devices.archive(s.device.id);
            s.audit.record({
                source: 'agent',
                category: 'device',
                action: 'device.destroyed',
                level: 'warning',
                uid: s.ownerId,
                ip: s.ip,
                description: `Agent auto-détruit, appareil archivé : « ${s.device.name} »`,
                metadata: { deviceId: s.device.id }
            });
        } catch (e) {
            s.logger.error({ err: (e as Error).message }, 'Failed to archive destroyed device');
        }
    } else {
        const reason = payload.error ?? "Échec de l'auto-destruction";
        try {
            await s.db.devices.failDeletion(s.device.id, reason);
            s.audit.record({
                source: 'agent',
                category: 'device',
                action: 'device.destroyFailed',
                level: 'error',
                uid: s.ownerId,
                ip: s.ip,
                description: `Échec de l'auto-destruction : « ${s.device.name} » — ${reason}`,
                metadata: { deviceId: s.device.id }
            });
        } catch (e) {
            s.logger.error({ err: (e as Error).message }, 'Failed to record destroy failure');
        }
    }
    ack(s, 1);
}

/** `agent.serviceResult` — result of a persistence/privilege change. */
export async function handleServiceResult(
    s: AgentSession,
    payload: PayloadOf<typeof AGENT_SERVICE_RESULT>
): Promise<void> {
    const { action, ok, needsManualCommand, error } = payload;
    const description = ok
        ? `Service agent modifié (${action}) : « ${s.device.name} »`
        : needsManualCommand
          ? `Action service « ${action} » à exécuter sur l'appareil : « ${s.device.name} »`
          : `Échec action service « ${action} » : « ${s.device.name} »${error ? ` — ${error}` : ''}`;
    s.audit.record({
        source: 'agent',
        category: 'device',
        action: ok ? 'device.serviceChanged' : 'device.serviceFailed',
        level: ok ? 'info' : 'warning',
        uid: s.ownerId,
        ip: s.ip,
        description,
        metadata: { deviceId: s.device.id, serviceAction: action, ok, needsManualCommand: needsManualCommand ?? false }
    });
    // Le résultat repart vers l'interface, comme celui d'une action système. Ne
    // l'écrire qu'au journal d'audit revenait à ne rien dire à qui venait de
    // cliquer : le démarrage automatique pouvait échouer sur l'appareil, la
    // carte se contentait de revenir à son état d'avant, sans un mot.
    s.hub.publishService({ deviceId: s.device.id, action, ok, needsManualCommand, error });
    ack(s, 1);
}

/** `agent.powerResult` — outcome of a system power action. Audit + fan out to the
 *  device's subscribers so the UI confirms the action (or shows why it failed).
 *  A successful shutdown/reboot is also followed by an offline presence event. */
export async function handlePowerResult(s: AgentSession, payload: PayloadOf<typeof AGENT_POWER_RESULT>): Promise<void> {
    const { action, ok, error } = payload;
    const label = POWER_LABELS[action] ?? action;
    s.audit.record({
        source: 'agent',
        category: 'device',
        action: ok ? 'device.power' : 'device.powerFailed',
        level: 'warning',
        uid: s.ownerId,
        ip: s.ip,
        description: ok
            ? `Commande système « ${label} » exécutée : « ${s.device.name} »`
            : `Échec de la commande système « ${label} » : « ${s.device.name} »${error ? ` — ${error}` : ''}`,
        metadata: { deviceId: s.device.id, powerAction: action, ok, error: error ?? null }
    });
    s.hub.publishPower({ deviceId: s.device.id, action, ok, error });
    ack(s, 1);
}
