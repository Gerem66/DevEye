import { AGENT_PKG_DONE, AGENT_PKG_LIST_RESULT, AGENT_PKG_PROGRESS } from 'deveye-types';

import { ack, type AgentSession, type PayloadOf } from './session';

/**
 * Package-manager events streamed by the agent (`pkg.list` enumeration, live
 * `pkg.progress` lines, terminal `pkg.done`). All are fanned out to the device's
 * subscribed user sockets; only the start/end frames are acked (progress is a
 * fire-and-forget stream, so it isn't, to avoid ack flooding).
 */

export function handlePkgListResult(s: AgentSession, payload: PayloadOf<typeof AGENT_PKG_LIST_RESULT>): void {
    s.hub.publishPackageList(payload);
    ack(s, payload.managers.length);
}

export function handlePkgProgress(s: AgentSession, payload: PayloadOf<typeof AGENT_PKG_PROGRESS>): void {
    s.hub.publishPackageProgress(payload);
}

export function handlePkgDone(s: AgentSession, payload: PayloadOf<typeof AGENT_PKG_DONE>): void {
    // Le verrou tombe avant la diffusion : les écrans qui reçoivent la fin
    // ré-interrogent la liste dans la foulée, et elle doit déjà dire « plus rien
    // en cours » — sinon le bouton resterait grisé jusqu'au prochain passage.
    s.hub.endUpgrade(s.device.id, payload.manager);
    s.hub.publishPackageDone(payload);
    s.audit.record({
        source: 'agent',
        category: 'device',
        action: payload.ok ? 'device.packagesUpgraded' : 'device.packagesUpgradeFailed',
        level: payload.ok ? 'info' : 'warning',
        uid: s.ownerId,
        ip: s.ip,
        description: payload.ok
            ? `Mises à jour appliquées (${payload.manager}) : « ${s.device.name} »${payload.rebootRequired ? ' — redémarrage requis' : ''}`
            : `Échec des mises à jour (${payload.manager}) : « ${s.device.name} »${payload.error ? ` — ${payload.error}` : ''}`,
        metadata: { deviceId: s.device.id, manager: payload.manager, ok: payload.ok }
    });
    // Les compteurs viennent de changer sur la machine : on relance l'inventaire
    // pour tout le monde d'un seul coup (voir `refreshPackagesIfWatched`).
    if (payload.ok) s.hub.refreshPackagesIfWatched(s.device.id);
    ack(s, 1);
}
