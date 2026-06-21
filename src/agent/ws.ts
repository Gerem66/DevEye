import type { WebSocket } from '@fastify/websocket';
import {
    AGENT_ACK,
    AGENT_CONFIG,
    AGENT_ERROR,
    AGENT_HELLO,
    AGENT_METRICS_BATCH,
    AGENT_PROCESSES,
    AGENT_REPORT,
    agentClientMessageSchema,
    type AgentServerMessage
} from 'deveye-types';
import type { FastifyInstance } from 'fastify';

import { verifyDeviceToken } from '@/auth/jwt';
import { sha256hex } from '@/Utils/hash';
import { logger } from '@/logger';
import { deviceAgentConfig } from './mappers';
import type { MonitorHub } from './hub';

import type { Database } from '@/db';
import type { AuditLog } from '@/Services/AuditLog';

interface AgentWSDeps {
    db: Database;
    hub: MonitorHub;
    audit: AuditLog;
}

function send(socket: WebSocket, msg: AgentServerMessage): void {
    socket.send(JSON.stringify(msg));
}

function extractToken(req: { headers: Record<string, unknown>; query: unknown }): string | null {
    const auth = req.headers['authorization'];
    if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7);
    const q = req.query as { token?: unknown } | undefined;
    if (q && typeof q.token === 'string') return q.token;
    return null;
}

/**
 * Agent <-> server WebSocket. Authenticated with a device token; streams metric
 * batches which are persisted and fanned out to subscribed user sockets.
 */
export async function registerAgentWS(app: FastifyInstance, { db, hub, audit }: AgentWSDeps): Promise<void> {
    app.get('/agent', { websocket: true }, async (socket, req) => {
        const token = extractToken(req);
        if (!token) {
            socket.close(4401, 'unauthorized');
            return;
        }
        const claims = await verifyDeviceToken(token);
        if (!claims) {
            socket.close(4401, 'unauthorized');
            return;
        }

        const device = await db.devices.findById(claims.sub);
        if (!device || device.status === 'revoked' || device.token_hash !== sha256hex(token)) {
            socket.close(4403, 'forbidden');
            return;
        }

        const deviceId = device.id;
        const reqLogger = logger.child({ deviceId, ownerId: claims.oid });
        reqLogger.info('Agent connected');
        hub.agentOnline(deviceId, socket);
        // Tell the agent its collection cadences + capture mode straight away.
        send(socket, { command: AGENT_CONFIG, payload: deviceAgentConfig(device) });
        await db.devices.touchSeen(deviceId, Math.floor(Date.now() / 1000));
        await db.presence.record(deviceId, Date.now(), true);
        audit.record({
            source: 'agent',
            category: 'device',
            action: 'agent.connect',
            level: 'info',
            uid: claims.oid,
            ip: req.ip,
            description: `Agent connecté : appareil « ${device.name} »`,
            metadata: { deviceId, status: device.status }
        });

        socket.on('message', async (raw: Buffer) => {
            let parsed;
            try {
                parsed = agentClientMessageSchema.safeParse(JSON.parse(raw.toString()));
            } catch {
                send(socket, { command: AGENT_ERROR, payload: { code: 'validation', message: 'Malformed JSON' } });
                return;
            }
            if (!parsed.success) {
                send(socket, {
                    command: AGENT_ERROR,
                    payload: { code: 'validation', message: 'Invalid agent message' }
                });
                return;
            }

            const msg = parsed.data;
            if (msg.command === AGENT_HELLO) {
                send(socket, { command: AGENT_ACK, payload: { received: 0 } });
                return;
            }

            if (msg.command === AGENT_REPORT) {
                // Reports persist only for confirmed devices (same gate as metrics).
                if (device.status !== 'active') {
                    send(socket, { command: AGENT_ACK, payload: { received: 0 } });
                    return;
                }
                try {
                    await db.devices.setReport(deviceId, JSON.stringify(msg.payload.report));
                    hub.publishReport(deviceId, msg.payload.report);
                    await db.devices.touchSeen(deviceId, Math.floor(Date.now() / 1000));
                    send(socket, { command: AGENT_ACK, payload: { received: 1 } });
                } catch (e) {
                    reqLogger.error({ err: (e as Error).message }, 'Failed to persist device report');
                    send(socket, { command: AGENT_ERROR, payload: { code: 'internal', message: 'Persist failed' } });
                }
                return;
            }

            if (msg.command === AGENT_PROCESSES) {
                // Process history persists only for confirmed devices.
                if (device.status !== 'active') {
                    send(socket, { command: AGENT_ACK, payload: { received: 0 } });
                    return;
                }
                try {
                    await db.processSamples.insertSample(deviceId, msg.payload.sample);
                    send(socket, { command: AGENT_ACK, payload: { received: msg.payload.sample.processes.length } });
                } catch (e) {
                    reqLogger.error({ err: (e as Error).message }, 'Failed to persist process sample');
                    send(socket, { command: AGENT_ERROR, payload: { code: 'internal', message: 'Persist failed' } });
                }
                return;
            }

            if (msg.command === AGENT_METRICS_BATCH) {
                // Devices only persist metrics once the owner has confirmed them.
                if (device.status !== 'active') {
                    send(socket, { command: AGENT_ACK, payload: { received: 0 } });
                    return;
                }
                const { snapshots } = msg.payload;
                try {
                    await db.metrics.insertBatch(deviceId, snapshots);
                    for (const snapshot of snapshots) hub.publishMetric(deviceId, snapshot);
                    await db.devices.touchSeen(deviceId, Math.floor(Date.now() / 1000));
                    send(socket, { command: AGENT_ACK, payload: { received: snapshots.length } });
                } catch (e) {
                    reqLogger.error({ err: (e as Error).message }, 'Failed to persist metrics batch');
                    send(socket, { command: AGENT_ERROR, payload: { code: 'internal', message: 'Persist failed' } });
                }
            }
        });

        socket.on('close', () => {
            hub.agentOffline(deviceId);
            void db.presence.record(deviceId, Date.now(), false).catch(() => {});
            reqLogger.info('Agent disconnected');
        });
    });
}
