import type { WebSocket } from '@fastify/websocket';
import { AGENT_ACK, type AgentClientMessage, type AgentServerMessage, type DeviceRow } from 'deveye-types';
import type { Logger } from 'pino';

import type { CloudSyncEngine } from '@/cloudSync/engine';
import type { Database } from '@/db';
import type { AuditLog } from '@/Services/AuditLog';
import type { SecurityMonitor } from '@/Services/SecurityMonitor';
import type { MonitorHub } from '../hub';

/**
 * Everything an agent-message handler needs, captured once at connection time and
 * shared by every handler in this folder. `device` is the snapshot taken at
 * connect (son `status` est relu à la volée quand il refuse — voir `gated` —,
 * son `name` alimente les descriptions d.audit) ; les handlers qui écrivent la
 * ligne appareil la relisent eux-mêmes.
 */
export interface AgentSession {
    socket: WebSocket;
    db: Database;
    hub: MonitorHub;
    cloudSync: CloudSyncEngine;
    /**
     * Moteur Sentinelle. Les handlers ne lui adressent que des `enqueue*` : ils
     * empilent, il évalue à son tour de boucle. Optionnel pour que les chemins
     * qui construisent une session sans moteur (tests) restent possibles.
     */
    sentinel?: SecurityMonitor;
    audit: AuditLog;
    logger: Logger;
    /** Owner user id (from the device-token claims); the audit actor. */
    ownerId: number;
    /** Client IP of the agent connection, recorded on audited actions. */
    ip: string;
    /** Mis à jour sur place quand le statut change sous la session (cf. `gated`). */
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
