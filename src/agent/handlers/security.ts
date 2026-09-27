import { AGENT_AUTH_EVENTS, AGENT_INTEGRITY } from '@deveye/types';

import { ack, type AgentSession, type PayloadOf } from './session';
import { gated } from './telemetry';

/**
 * Les deux relevés de Sentinelle : le manifeste des surfaces de persistance et
 * la fenêtre d'issues d'authentification.
 *
 * Ces handlers n'évaluent rien : ils tendent le relevé aux hooks des modules,
 * qui empilent et évaluent à leur tour de boucle, hors de la pile de la socket.
 * Rien n'est stocké brut : le module ne garde que le résultat du diff et ses
 * constats. La socket n'admet que `active` ; qu'un appareil soit surveillé ou
 * non, c'est le module qui le sait, et son hook jette ce qu'il n'a pas demandé.
 * Un relevé écarté est accusé quand même : un agent sans accusé réémet.
 */

export async function handleIntegrity(s: AgentSession, payload: PayloadOf<typeof AGENT_INTEGRITY>): Promise<void> {
    if (gated(s)) return;
    const { integrity } = payload;
    s.hooks.onIntegrity(s.device.id, integrity);
    ack(s, integrity.entries.length);
}

export async function handleAuthEvents(s: AgentSession, payload: PayloadOf<typeof AGENT_AUTH_EVENTS>): Promise<void> {
    if (gated(s)) return;
    const { auth } = payload;
    s.hooks.onAuthEvents(s.device.id, auth);
    ack(s, auth.topSources.length + auth.logins.length);
}
