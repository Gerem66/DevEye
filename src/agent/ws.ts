import type { WebSocket } from '@fastify/websocket';
import {
    AGENT_CONFIG,
    AGENT_DESTROY,
    AGENT_DESTROYED,
    AGENT_ERROR,
    AGENT_FILES_CHUNK,
    AGENT_FILES_LISTING,
    AGENT_FILES_MATCHES,
    AGENT_FILES_OP_RESULT,
    AGENT_FILES_USAGE,
    AGENT_HELLO,
    AGENT_LOG_LINES,
    AGENT_LOG_SOURCES_RESULT,
    AGENT_METRICS_BATCH,
    AGENT_PKG_DONE,
    AGENT_PKG_LIST_RESULT,
    AGENT_PKG_PROGRESS,
    AGENT_POWER_RESULT,
    AGENT_REPORT,
    AGENT_SERVICE_RESULT,
    AGENT_SYNC_ACK,
    AGENT_SYNC_CHANGED,
    AGENT_SYNC_CHUNK,
    AGENT_SYNC_INDEX,
    AGENT_SYNC_OP_RESULT,
    AGENT_TERM_EXIT,
    AGENT_TERM_OUTPUT,
    AGENT_UPDATED,
    agentClientMessageSchema,
    type AgentClientMessage,
    type AgentServerMessage
} from 'deveye-types';
import type { FastifyInstance } from 'fastify';

import { verifyDeviceToken } from '@/auth/jwt';
import { sha256hex } from '@/Utils/hash';
import { logger } from '@/logger';
import {
    handleDestroyed,
    handleHello,
    handleFilesChunk,
    handleFilesListing,
    handleFilesMatches,
    handleFilesOpResult,
    handleFilesUsage,
    handleLogLines,
    handleLogSourcesResult,
    handleMetricsBatch,
    handlePkgDone,
    handlePkgListResult,
    handlePkgProgress,
    handlePowerResult,
    handleReport,
    handleServiceResult,
    handleSyncAck,
    handleSyncChanged,
    handleSyncChunk,
    handleSyncIndex,
    handleSyncOpResult,
    handleTermExit,
    handleTermOutput,
    handleUpdated,
    type AgentSession
} from './handlers';
import { deviceAgentConfig } from './mappers';
import { notifyDeviceWorkspaces, recordAgentOffline, recordAgentOnline } from './presence';
import type { LiveHub } from '@/live/hub';
import type { MonitorHub } from './hub';

import type { CloudSyncEngine } from '@/cloudSync/engine';
import type { Database } from '@/db';
import type { AuditLog } from '@/Services/AuditLog';

interface AgentWSDeps {
    db: Database;
    hub: MonitorHub;
    /** Présence en direct : un agent qui arrive ou part change la liste d'appareils. */
    live: LiveHub;
    cloudSync: CloudSyncEngine;
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

/** Route one validated agent frame to its handler. The big per-message logic lives
 *  in the focused `handlers/*` modules; this stays a thin, exhaustive dispatcher. */
function dispatch(session: AgentSession, msg: AgentClientMessage): void | Promise<void> {
    switch (msg.command) {
        case AGENT_HELLO:
            return handleHello(session, msg.payload);
        case AGENT_UPDATED:
            return handleUpdated(session, msg.payload);
        case AGENT_DESTROYED:
            return handleDestroyed(session, msg.payload);
        case AGENT_SERVICE_RESULT:
            return handleServiceResult(session, msg.payload);
        case AGENT_POWER_RESULT:
            return handlePowerResult(session, msg.payload);
        case AGENT_LOG_SOURCES_RESULT:
            return handleLogSourcesResult(session, msg.payload);
        case AGENT_LOG_LINES:
            return handleLogLines(session, msg.payload);
        case AGENT_TERM_OUTPUT:
            return handleTermOutput(session, msg.payload);
        case AGENT_TERM_EXIT:
            return handleTermExit(session, msg.payload);
        case AGENT_FILES_LISTING:
            return handleFilesListing(session, msg.payload);
        case AGENT_FILES_USAGE:
            return handleFilesUsage(session, msg.payload);
        case AGENT_FILES_MATCHES:
            return handleFilesMatches(session, msg.payload);
        case AGENT_FILES_OP_RESULT:
            return handleFilesOpResult(session, msg.payload);
        case AGENT_FILES_CHUNK:
            return handleFilesChunk(session, msg.payload);
        case AGENT_SYNC_CHANGED:
            return handleSyncChanged(session, msg.payload);
        case AGENT_SYNC_INDEX:
            return handleSyncIndex(session, msg.payload);
        case AGENT_SYNC_CHUNK:
            return handleSyncChunk(session, msg.payload);
        case AGENT_SYNC_ACK:
            return handleSyncAck(session, msg.payload);
        case AGENT_SYNC_OP_RESULT:
            return handleSyncOpResult(session, msg.payload);
        case AGENT_PKG_LIST_RESULT:
            return handlePkgListResult(session, msg.payload);
        case AGENT_PKG_PROGRESS:
            return handlePkgProgress(session, msg.payload);
        case AGENT_PKG_DONE:
            return handlePkgDone(session, msg.payload);
        case AGENT_REPORT:
            return handleReport(session, msg.payload);
        case AGENT_METRICS_BATCH:
            return handleMetricsBatch(session, msg.payload);
    }
}

/**
 * Agent <-> server WebSocket. Authenticated with a device token; streams metric
 * batches which are persisted and fanned out to subscribed user sockets. This
 * module owns the socket *lifecycle* (auth, connect, dispatch); the per-message
 * handling lives in `handlers/`.
 */
export async function registerAgentWS(
    app: FastifyInstance,
    { db, hub, live, cloudSync, audit }: AgentWSDeps
): Promise<void> {
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
            const wasOnlineInHub = hub.isOnline(deviceId);
            hub.agentOnline(deviceId, socket);
            // Tell the agent its collection cadences + capture mode straight away.
            send(socket, { command: AGENT_CONFIG, payload: deviceAgentConfig(device) });
            // CloudSync : pousse ses assignations puis rattrape le retard éventuel.
            void cloudSync.onAgentConnect(deviceId).catch((err) => {
                reqLogger.warn({ err }, 'CloudSync onAgentConnect failed');
            });
            // A transient DB error here must not reject the route handler: the
            // fresh, authenticated socket would be torn down, and an agent
            // retrying against a briefly unhealthy DB becomes an accept-then-
            // close reconnect storm. Log and keep the session alive instead.
            try {
                await db.devices.touchSeen(deviceId, Math.floor(Date.now() / 1000));
                await recordAgentOnline(db, device, wasOnlineInHub);
            } catch (err) {
                reqLogger.warn({ err }, 'Connect-time presence bookkeeping failed (socket kept open)');
            }
            // Un appareil vient de passer en ligne : c'est ce qui remplace le
            // sondage de la liste d'appareils côté client. `device.presence`
            // existe déjà, mais ne part qu'aux abonnés d'un appareil précis —
            // l'accueil, lui, n'est abonné à rien.
            await notifyDeviceWorkspaces(db, live, deviceId);
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

        const session: AgentSession = {
            socket,
            db,
            hub,
            cloudSync,
            audit,
            logger: reqLogger,
            ownerId: claims.oid,
            ip: req.ip,
            device
        };

        const handleMessage = async (raw: Buffer): Promise<void> => {
            let parsed;
            try {
                parsed = agentClientMessageSchema.safeParse(JSON.parse(raw.toString()));
            } catch {
                reqLogger.warn({ bytes: raw.length }, 'Agent sent malformed JSON');
                send(socket, { command: AGENT_ERROR, payload: { code: 'validation', message: 'Malformed JSON' } });
                return;
            }
            if (!parsed.success) {
                // Journalisé, et pas seulement renvoyé à l'agent : un agent dont
                // les trames ne valident plus n'apparaissait nulle part côté
                // serveur. De l'extérieur, la machine était « en ligne » et
                // muette, sans le moindre indice de la cause.
                reqLogger.warn(
                    {
                        command: (parsed.error.flatten().fieldErrors as { command?: string[] })?.command,
                        err: parsed.error.flatten()
                    },
                    'Agent frame rejected by validation'
                );
                send(socket, {
                    command: AGENT_ERROR,
                    payload: { code: 'validation', message: 'Invalid agent message' }
                });
                return;
            }
            // A throwing handler must neither crash the process (the dispatch
            // promise is fire-and-forget, so a rejection here is *unhandled* and
            // fatal on modern Node — the restart then disconnects every agent)
            // nor take the socket down with it.
            try {
                await dispatch(session, parsed.data);
            } catch (err) {
                reqLogger.error({ err, command: parsed.data.command }, 'Agent frame handler failed');
                send(socket, { command: AGENT_ERROR, payload: { code: 'internal', message: 'Handler failed' } });
            }
        };

        // Wire the real handler, then flush whatever arrived during auth/connect
        // (in order). New frames now go straight through; no await sits between the
        // assignment and the drain, so nothing can slip past unbuffered.
        onMessage = (raw) => void handleMessage(raw);
        for (const raw of earlyFrames.splice(0)) onMessage(raw);

        socket.on('close', () => {
            hub.agentOffline(deviceId, socket);
            // Une fermeture tardive d'un VIEUX socket (reconnexion rapide) ne doit
            // pas interrompre les sessions du nouveau — ni écrire une transition
            // « offline » fantôme dans la présence : le hub reste l'autorité.
            if (!hub.isOnline(deviceId)) {
                cloudSync.onAgentOffline(deviceId);
                if (device.status !== 'pending_deletion') {
                    void recordAgentOffline(db, deviceId).catch(() => {});
                }
                void notifyDeviceWorkspaces(db, live, deviceId).catch(() => {});
            }
            reqLogger.info('Agent disconnected');
        });
    });
}
