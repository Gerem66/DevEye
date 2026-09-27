import type { WebSocket } from '@fastify/websocket';
import { AGENT_ACK, type AgentClientMessage, type AgentServerMessage, type DeviceRow } from '@deveye/types';
import type { Logger } from 'pino';

import type { FeatureAgentHooks } from '@deveye/types/sdk/server';
import type { Database } from '@/db';
import type { AuditLog } from '@/Services/AuditLog';
import type { MonitorHub } from '../hub';

/**
 * Everything an agent-message handler needs, captured once at connection time and
 * shared by every handler in this folder. `device` is the snapshot taken at
 * connect; handlers that write the device row re-read it themselves.
 */
export interface AgentSession {
    socket: WebSocket;
    db: Database;
    hub: MonitorHub;
    /**
     * Les hooks agent des modules installés (agrégat no-op par défaut) : les
     * handlers leur tendent ce qu'ils ont persisté, et n'évaluent rien.
     */
    hooks: Required<FeatureAgentHooks>;
    audit: AuditLog;
    logger: Logger;
    /** Owner user id (from the device-token claims); the audit actor. */
    ownerId: number;
    /** Client IP of the agent connection, recorded on audited actions. */
    ip: string;
    /**
     * La ligne lue à la connexion. Un changement de statut coupe la session
     * (révoquer, archiver, mettre en pause) : l'instantané ne ment pas longtemps.
     */
    device: DeviceRow;
}

/** The payload type of a given agent→server command (narrowed from the union). */
export type PayloadOf<C extends AgentClientMessage['command']> = Extract<AgentClientMessage, { command: C }>['payload'];

/** Send one server→agent frame on this session's socket. */
export function reply(s: AgentSession, msg: AgentServerMessage): void {
    s.socket.send(JSON.stringify(msg));
}

/** Acknowledge a processed frame (`received` mirrors the count the agent sent). */
export function ack(s: AgentSession, received: number): void {
    reply(s, { command: AGENT_ACK, payload: { received } });
}
