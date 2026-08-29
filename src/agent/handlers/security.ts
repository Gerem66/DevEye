import { AGENT_AUTH_EVENTS, AGENT_INTEGRITY } from '@deveye/types';

import { ack, type AgentSession, type PayloadOf } from './session';

/**
 * Les deux relevés de Sentinelle : le manifeste des surfaces de persistance et
 * la fenêtre d'issues d'authentification.
 *
 * Ces handlers n'évaluent rien : ils tendent le relevé aux hooks des modules,
 * qui empilent et évaluent à leur tour de boucle, hors de la pile de la socket.
 * Rien n'est stocké brut : le module ne garde que le résultat du diff et ses
 * constats. L'app ne garde que `status === 'active'` ; qu'un appareil soit
 * surveillé ou non, c'est le module qui le sait, et son hook jette ce qu'il n'a
 * pas demandé.
 */

/**
 * True (et accuse réception) quand l'appareil n'a pas à être analysé. On accuse
 * quand même : un agent sans accusé réémet, et une machine tout juste révoquée
 * renverrait son manifeste en boucle.
 */
async function gated(s: AgentSession): Promise<boolean> {
    // Le statut de la session date de la connexion, et un agent reste connecté
    // des semaines : on relit la ligne plutôt que de refuser sur une donnée
    // périmée (même raison que `gated` dans `telemetry.ts`).
    const fresh = await s.db.devices.findById(s.device.id);
    if (fresh) s.device = fresh;

    if (s.device.status !== 'active') {
        s.logger.debug({ status: s.device.status }, 'Sentinel probe dropped: device not active');
        ack(s, 0);
        return true;
    }
    return false;
}

export async function handleIntegrity(s: AgentSession, payload: PayloadOf<typeof AGENT_INTEGRITY>): Promise<void> {
    if (await gated(s)) return;
    const { integrity } = payload;
    s.hooks.onIntegrity(s.device.id, integrity);
    ack(s, integrity.entries.length);
}

export async function handleAuthEvents(s: AgentSession, payload: PayloadOf<typeof AGENT_AUTH_EVENTS>): Promise<void> {
    if (await gated(s)) return;
    const { auth } = payload;
    s.hooks.onAuthEvents(s.device.id, auth);
    ack(s, auth.topSources.length + auth.logins.length);
}
