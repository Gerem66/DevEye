import type { WebSocket } from '@fastify/websocket';
import {
    AGENT_ACK,
    AGENT_CONFIG,
    AGENT_DESTROY,
    AGENT_DESTROYED,
    AGENT_ERROR,
    AGENT_HELLO,
    AGENT_METRICS_BATCH,
    AGENT_PROCESSES,
    AGENT_REPORT,
    AGENT_SERVICE_RESULT,
    AGENT_UPDATED,
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
        // Stealth: every authentication/authorization failure ends the connection
        // the exact same way, with no distinguishing code or reason. An outsider
        // probing the endpoint can't tell a missing/invalid token from an unknown,
        // revoked or archived device — it all looks like "nothing here".
        const deny = () => socket.close(1008);

        // The agent fires `agent.hello` the instant the socket opens — i.e. while
        // we're still in the async auth + connect-time DB writes below, before any
        // real `message` handler exists. Attach a listener synchronously from t=0
        // that buffers frames until the handler is wired, then replay them; without
        // this the first frame (the hello carrying the agent version) is dropped.
        const earlyFrames: Buffer[] = [];
        let onMessage: ((raw: Buffer) => void) | null = null;
        socket.on('message', (raw: Buffer) => {
            if (onMessage) onMessage(raw);
            else earlyFrames.push(raw);
        });

        const token = extractToken(req);
        if (!token) return deny();
        const claims = await verifyDeviceToken(token);
        if (!claims) return deny();

        const device = await db.devices.findById(claims.sub);
        if (!device || device.token_hash !== sha256hex(token)) return deny();
        // Revoked and archived devices are refused identically to unknown ones.
        if (device.status === 'revoked' || device.status === 'archived') return deny();

        const deviceId = device.id;
        const reqLogger = logger.child({ deviceId, ownerId: claims.oid });

        // A device marked for deletion is accepted just long enough to be told to
        // self-destruct; we send the destroy signal and wait for its reply
        // (handled below). No config, no persistence, no normal presence.
        if (device.status === 'pending_deletion') {
            reqLogger.info('Agent connected while pending deletion — sending destroy');
            hub.agentOnline(deviceId, socket);
            send(socket, { command: AGENT_DESTROY, payload: {} });
        } else {
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
        }

        const handleMessage = async (raw: Buffer): Promise<void> => {
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
                // Remember which agent build + target is running so the UI can flag
                // stale agents and the server can resolve the right self-update binary.
                try {
                    await db.devices.setAgentVersion(deviceId, msg.payload.agentVersion);
                    if (msg.payload.target) await db.devices.setAgentTarget(deviceId, msg.payload.target);
                } catch (e) {
                    reqLogger.warn({ err: (e as Error).message }, 'Failed to persist agent version/target');
                }
                send(socket, { command: AGENT_ACK, payload: { received: 0 } });
                return;
            }

            if (msg.command === AGENT_UPDATED) {
                // Outcome of an `agent.update`. On success the agent restarts and
                // reconnects with its new version (via `agent.hello`); we just audit
                // the result here. On failure the agent kept its old binary.
                const { ok, version, error } = msg.payload;
                audit.record({
                    source: 'agent',
                    category: 'device',
                    action: ok ? 'device.agentUpdated' : 'device.agentUpdateFailed',
                    level: ok ? 'info' : 'error',
                    uid: claims.oid,
                    ip: req.ip,
                    description: ok
                        ? `Agent mis à jour : « ${device.name} »${version ? ` → ${version}` : ''}`
                        : `Échec de la mise à jour de l'agent : « ${device.name} » — ${error ?? 'raison inconnue'}`,
                    metadata: { deviceId, version: version ?? null, error: error ?? null }
                });
                send(socket, { command: AGENT_ACK, payload: { received: 1 } });
                return;
            }

            if (msg.command === AGENT_DESTROYED) {
                // The agent reports the outcome of its self-destruction.
                if (msg.payload.ok) {
                    try {
                        await db.devices.archive(deviceId);
                        audit.record({
                            source: 'agent',
                            category: 'device',
                            action: 'device.destroyed',
                            level: 'warning',
                            uid: claims.oid,
                            ip: req.ip,
                            description: `Agent auto-détruit, appareil archivé : « ${device.name} »`,
                            metadata: { deviceId }
                        });
                    } catch (e) {
                        reqLogger.error({ err: (e as Error).message }, 'Failed to archive destroyed device');
                    }
                } else {
                    const reason = msg.payload.error ?? "Échec de l'auto-destruction";
                    try {
                        await db.devices.failDeletion(deviceId, reason);
                        audit.record({
                            source: 'agent',
                            category: 'device',
                            action: 'device.destroyFailed',
                            level: 'error',
                            uid: claims.oid,
                            ip: req.ip,
                            description: `Échec de l'auto-destruction : « ${device.name} » — ${reason}`,
                            metadata: { deviceId }
                        });
                    } catch (e) {
                        reqLogger.error({ err: (e as Error).message }, 'Failed to record destroy failure');
                    }
                }
                send(socket, { command: AGENT_ACK, payload: { received: 1 } });
                return;
            }

            if (msg.command === AGENT_SERVICE_RESULT) {
                // Outcome of an `agent.service` change. The effective scope comes
                // back on the next `agent.report`; here we just audit the result.
                const { action, ok, needsManualCommand, error } = msg.payload;
                const description = ok
                    ? `Service agent modifié (${action}) : « ${device.name} »`
                    : needsManualCommand
                      ? `Action service « ${action} » à exécuter sur l'appareil : « ${device.name} »`
                      : `Échec action service « ${action} » : « ${device.name} »${error ? ` — ${error}` : ''}`;
                audit.record({
                    source: 'agent',
                    category: 'device',
                    action: ok ? 'device.serviceChanged' : 'device.serviceFailed',
                    level: ok ? 'info' : 'warning',
                    uid: claims.oid,
                    ip: req.ip,
                    description,
                    metadata: { deviceId, serviceAction: action, ok, needsManualCommand: needsManualCommand ?? false }
                });
                send(socket, { command: AGENT_ACK, payload: { received: 1 } });
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
        };

        // Wire the real handler, then flush whatever arrived during auth/connect
        // (in order). New frames now go straight through; no await sits between the
        // assignment and the drain, so nothing can slip past unbuffered.
        onMessage = (raw) => void handleMessage(raw);
        for (const raw of earlyFrames.splice(0)) onMessage(raw);

        socket.on('close', () => {
            hub.agentOffline(deviceId, socket);
            void db.presence.record(deviceId, Date.now(), false).catch(() => {});
            reqLogger.info('Agent disconnected');
        });
    });
}
