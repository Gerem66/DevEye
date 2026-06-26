import type { WebSocket } from '@fastify/websocket';
import { AGENT_ACK, type AgentClientMessage, type AgentServerMessage, type DeviceRow } from 'deveye-types';
import type { Logger } from 'pino';

import type { Database } from '@/db';
import type { AuditLog } from '@/Services/AuditLog';
import type { MonitorHub } from '../hub';

/**
 * Everything an agent-message handler needs, captured once at connection time and
 * shared by every handler in this folder. `device` is the snapshot taken at
 * connect (its `status` gates telemetry persistence, its `name` feeds audit
 * descriptions) — handlers that change persisted device state re-read it themselves.
 */
export interface AgentSession {
    socket: WebSocket;
    db: Database;
    hub: MonitorHub;
    audit: AuditLog;
    logger: Logger;
    /** Owner user id (from the device-token claims); the audit actor. */
    ownerId: number;
    /** Client IP of the agent connection, recorded on audited actions. */
    ip: string;
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
