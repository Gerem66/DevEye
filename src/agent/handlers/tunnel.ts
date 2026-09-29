import { AGENT_TUNNEL_CLOSED, AGENT_TUNNEL_DATA, AGENT_TUNNEL_OPENED } from '@deveye/types';

import type { AgentSession, PayloadOf } from './session';

// Pas d'accusé de réception : les crédits du tunnel en tiennent lieu, et un
// accusé par pièce doublerait les trames d'un `pg_dump`.

export function handleTunnelOpened(s: AgentSession, payload: PayloadOf<typeof AGENT_TUNNEL_OPENED>): void {
    s.hub.tunnels.opened(s.device.id, s.socket, payload);
}

export function handleTunnelData(s: AgentSession, payload: PayloadOf<typeof AGENT_TUNNEL_DATA>): void {
    s.hub.tunnels.data(s.device.id, s.socket, payload);
}

export function handleTunnelClosed(s: AgentSession, payload: PayloadOf<typeof AGENT_TUNNEL_CLOSED>): void {
    s.hub.tunnels.closed(s.device.id, s.socket, payload);
}
