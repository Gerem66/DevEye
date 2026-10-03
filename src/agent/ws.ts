import type { WebSocket } from '@fastify/websocket';
import {
    AGENT_CLOSE_PENDING_APPROVAL,
    AGENT_CONFIG,
    AGENT_DESTROY,
    AGENT_DESTROYED,
    AGENT_ERROR,
    AGENT_FILES_ARCHIVE_CHUNK,
    AGENT_FILES_ARCHIVE_END,
    AGENT_TUNNEL_CLOSED,
    AGENT_TUNNEL_DATA,
    AGENT_TUNNEL_OPENED,
    AGENT_FILES_ARCHIVE_PROGRESS,
    AGENT_FILES_CHUNK,
    AGENT_FILES_LISTING,
    AGENT_FILES_MATCHES,
    AGENT_FILES_OP_RESULT,
    AGENT_FILES_USAGE,
    AGENT_HELLO,
    AGENT_LOG_LINES,
    AGENT_DOCKER_DONE,
    AGENT_DOCKER_INVENTORY_RESULT,
    AGENT_DOCKER_PROGRESS,
    AGENT_DOCKER_STATS_RESULT,
    AGENT_LOG_SOURCES_RESULT,
    AGENT_AUTH_EVENTS,
    AGENT_INTEGRITY,
    AGENT_METRICS_BATCH,
    AGENT_PKG_COUNT,
    AGENT_PKG_DONE,
    AGENT_PKG_LIST_RESULT,
    AGENT_PKG_PROGRESS,
    AGENT_POWER_RESULT,
    AGENT_REPORT,
    AGENT_SERVICE_RESULT,
    AGENT_SYNC_ACK,
    AGENT_SYNC_BUSY,
    AGENT_SYNC_CHANGED,
    AGENT_SYNC_CHUNK,
    AGENT_SYNC_DEVICE_KEY,
    AGENT_SYNC_INDEX,
    AGENT_SYNC_OP_RESULT,
    AGENT_TERM_EXIT,
    AGENT_TERM_OUTPUT,
    AGENT_UPDATED,
    agentClientMessageSchema,
    type AgentClientMessage,
    type AgentServerMessage,
    AGENT_TOKEN_ROTATE,
    type DeviceRow
} from '@deveye/types';
import type { FastifyInstance } from 'fastify';

import { signDeviceToken, type DeviceClaims } from '@/auth/jwt';
import { sha256hex } from '@/Utils/hash';
import { logger } from '@/logger';
import { isPlanPaused } from '@/Services/planPauses';
import {
    handleAuthEvents,
    handleDestroyed,
    handleHello,
    handleIntegrity,
    handleFilesArchiveChunk,
    handleFilesArchiveEnd,
    handleFilesArchiveProgress,
    handleFilesChunk,
    handleFilesListing,
    handleFilesMatches,
    handleFilesOpResult,
    handleFilesUsage,
    handleLogLines,
    handleDockerDone,
    handleDockerInventoryResult,
    handleDockerProgress,
    handleDockerStatsResult,
    handleLogSourcesResult,
    handleMetricsBatch,
    handlePkgCount,
    handlePkgDone,
    handlePkgListResult,
    handlePkgProgress,
    handlePowerResult,
    handleReport,
    handleServiceResult,
    handleSyncAck,
    handleSyncBusy,
    handleSyncChanged,
    handleSyncChunk,
    handleSyncDeviceKey,
    handleSyncIndex,
    handleSyncOpResult,
    handleTermExit,
    handleTermOutput,
    handleTunnelClosed,
    handleTunnelData,
    handleTunnelOpened,
    handleUpdated,
    type AgentSession
} from './handlers';
import { agentConfigFor } from './config';
import { authenticateDevice, deviceTokenOf } from './deviceAuth';
import { agentFrame } from './orders';
import { notifyDeviceWorkspaces, recordAgentOffline, recordAgentOnline } from './presence';
import type { LiveHub } from '@/live/hub';
import type { MonitorHub } from './hub';

import type { FeatureAgentHooks } from '@deveye/types/sdk/server';
import type { Database } from '@/db';
import type { AuditLog } from '@/Services/AuditLog';

interface AgentWSDeps {
    db: Database;
    hub: MonitorHub;
    /** Présence en direct : un agent qui arrive ou part change la liste d'appareils. */
    live: LiveHub;
    /** Les hooks agent des modules installés (voir `moduleAgentHooks`). */
    hooks: Required<FeatureAgentHooks>;
    audit: AuditLog;
}

function send(socket: WebSocket, msg: AgentServerMessage): void {
    socket.send(agentFrame(msg.command, msg.payload));
}

/** En dessous de ce reste de vie, le jeton est remplacé à la connexion. */
const TOKEN_ROTATE_BELOW_SECONDS = 7 * 24 * 3600;

/**
 * Un appareil que l'offre de son propriétaire tient en pause est refusé comme
 * un révoqué : l'agent réessaie de lui-même, sans rien effacer. Sauf quand son
 * jeton approche de sa fin : il reçoit d'abord le suivant, sans quoi une pause
 * de plus d'un mois forcerait à relier l'appareil.
 */
export function admitPausedAgent(
    claims: Pick<DeviceClaims, 'exp'>,
    presented: 'current' | 'previous',
    nowSeconds: number
): 'deny' | 'rotate-then-close' {
    const due = claims.exp === undefined || claims.exp - nowSeconds < TOKEN_ROTATE_BELOW_SECONDS;
    return presented === 'previous' || due ? 'rotate-then-close' : 'deny';
}

/** Le temps que l'agent sorte de sa fenêtre de config et lise le jeton, avant la fermeture. */
const PAUSED_ROTATION_GRACE_MS = 3_000;

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
        case AGENT_DOCKER_INVENTORY_RESULT:
            return handleDockerInventoryResult(session, msg.payload);
        case AGENT_DOCKER_STATS_RESULT:
            return handleDockerStatsResult(session, msg.payload);
        case AGENT_DOCKER_PROGRESS:
            return handleDockerProgress(session, msg.payload);
        case AGENT_DOCKER_DONE:
            return handleDockerDone(session, msg.payload);
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
        case AGENT_FILES_ARCHIVE_CHUNK:
            return handleFilesArchiveChunk(session, msg.payload);
        case AGENT_FILES_ARCHIVE_PROGRESS:
            return handleFilesArchiveProgress(session, msg.payload);
        case AGENT_FILES_ARCHIVE_END:
            return handleFilesArchiveEnd(session, msg.payload);
        case AGENT_TUNNEL_OPENED:
            return handleTunnelOpened(session, msg.payload);
        case AGENT_TUNNEL_DATA:
            return handleTunnelData(session, msg.payload);
        case AGENT_TUNNEL_CLOSED:
            return handleTunnelClosed(session, msg.payload);
        case AGENT_SYNC_CHANGED:
            return handleSyncChanged(session, msg.payload);
        case AGENT_SYNC_INDEX:
            return handleSyncIndex(session, msg.payload);
        case AGENT_SYNC_CHUNK:
            return handleSyncChunk(session, msg.payload);
        case AGENT_SYNC_ACK:
            return handleSyncAck(session, msg.payload);
        case AGENT_SYNC_BUSY:
            return handleSyncBusy(session, msg.payload);
        case AGENT_SYNC_OP_RESULT:
            return handleSyncOpResult(session, msg.payload);
        case AGENT_SYNC_DEVICE_KEY:
            return handleSyncDeviceKey(session, msg.payload);
        case AGENT_PKG_LIST_RESULT:
            return handlePkgListResult(session, msg.payload);
        case AGENT_PKG_COUNT:
            return handlePkgCount(session, msg.payload);
        case AGENT_PKG_PROGRESS:
            return handlePkgProgress(session, msg.payload);
        case AGENT_PKG_DONE:
            return handlePkgDone(session, msg.payload);
        case AGENT_REPORT:
            return handleReport(session, msg.payload);
        case AGENT_METRICS_BATCH:
            return handleMetricsBatch(session, msg.payload);
        case AGENT_INTEGRITY:
            return handleIntegrity(session, msg.payload);
        case AGENT_AUTH_EVENTS:
            return handleAuthEvents(session, msg.payload);
    }
}

/**
 * Remplace le jeton d'un appareil à la connexion quand il approche de sa fin,
 * n'expire pas (émis avant que les jetons n'expirent), ou quand l'agent présente
 * encore l'ancien (la trame précédente s'est perdue, ou n'a pas pu être
 * enregistrée). L'ancien condensé reste accepté jusqu'à ce que l'agent
 * s'authentifie avec le nouveau : une rotation ne peut pas couper une machine.
 * Un échec ne ferme pas la socket, la connexion suivante réessaie.
 */
async function rotateTokenIfDue(
    db: Database,
    socket: WebSocket,
    device: DeviceRow,
    claims: DeviceClaims,
    presented: 'current' | 'previous',
    log: { warn: (obj: unknown, msg: string) => void; info: (msg: string) => void }
): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const due = claims.exp === undefined || claims.exp - now < TOKEN_ROTATE_BELOW_SECONDS;
    try {
        if (presented === 'current' && !due) {
            if (device.token_hash_prev) await db.devices.clearPreviousTokenHash(device.id);
            return;
        }
        const token = await signDeviceToken(device.id, claims.oid);
        // L'agent tient toujours le jeton qu'il vient de présenter : c'est lui qui
        // doit rester valable, que ce soit le courant ou déjà le précédent.
        const stillHeld = presented === 'current' ? device.token_hash : device.token_hash_prev;
        await db.devices.setTokenHashes(device.id, sha256hex(token), stillHeld);
        send(socket, { command: AGENT_TOKEN_ROTATE, payload: { token } });
        log.info('Device token rotated');
    } catch (err) {
        log.warn({ err }, 'Device token rotation failed (socket kept open)');
    }
}

/**
 * Agent <-> server WebSocket. Authenticated with a device token; streams metric
 * batches which are persisted and fanned out to subscribed user sockets. This
 * module owns the socket *lifecycle* (auth, connect, dispatch); the per-message
 * handling lives in `handlers/`.
 */
const AGENT_FRAME_MAX_BYTES = 4 * 1024 * 1024;

export async function registerAgentWS(
    app: FastifyInstance,
    { db, hub, live, hooks, audit }: AgentWSDeps
): Promise<void> {
    app.get('/agent', { websocket: true }, async (socket, req) => {
        // Stealth: every authentication/authorization failure ends the connection
        // the same way, so a probe can't tell an invalid token from an unknown
        // or archived device. Only a valid token learns its device is pending
        // (`AGENT_CLOSE_PENDING_APPROVAL`).
        const deny = () => socket.close(1008);

        // The agent fires `agent.hello` the instant the socket opens, while the
        // async auth below is still running. Buffer frames from t=0 until the real
        // handler is wired, then replay them; otherwise the hello is dropped.
        const earlyFrames: Buffer[] = [];
        let onMessage: ((raw: Buffer) => void) | null = null;
        socket.on('message', (raw: Buffer) => {
            // La plus grosse trame d'un agent est une sortie de terminal (2 Mo)
            // ou un morceau de fichier (1,4 Mo) ; au-delà, l'agent n'est pas le nôtre.
            if (raw.length > AGENT_FRAME_MAX_BYTES) {
                socket.close(1009, 'frame too big');
                return;
            }
            if (onMessage) onMessage(raw);
            else earlyFrames.push(raw);
        });

        const presentedToken = deviceTokenOf(req);
        if (!presentedToken) return deny();
        const authenticated = await authenticateDevice(db, presentedToken.token);
        if (!authenticated) return deny();
        const { device, claims, presented } = authenticated;
        if (device.status === 'archived') return deny();
        // Réappairé et pas encore approuvé : ni config, ni hooks, ni ordres. Ce
        // code dit à l'agent de réessayer court au lieu de reculer comme un refusé.
        if (device.status === 'pending') return socket.close(AGENT_CLOSE_PENDING_APPROVAL);
        if (device.status === 'active' && isPlanPaused('devices.agents', device.id)) {
            if (admitPausedAgent(claims, presented, Math.floor(Date.now() / 1000)) === 'deny') return deny();
            // L'agent ne lit une rotation qu'une fois sa config reçue. Aucun
            // gestionnaire n'est branché : ce qu'il envoie d'ici là est ignoré.
            const pausedLog = logger.child({ deviceId: device.id, ownerId: claims.oid });
            send(socket, { command: AGENT_CONFIG, payload: await agentConfigFor(db, device) });
            await rotateTokenIfDue(db, socket, device, claims, presented, pausedLog);
            setTimeout(() => socket.close(1012), PAUSED_ROTATION_GRACE_MS).unref();
            return;
        }

        const deviceId = device.id;
        const reqLogger = logger.child({ deviceId, ownerId: claims.oid });
        if (presentedToken.fromQuery) {
            reqLogger.info(
                { cause: 'user' },
                'Agent authenticated with its token in the URL: it predates the header transport, update it'
            );
        }

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
            send(socket, { command: AGENT_CONFIG, payload: await agentConfigFor(db, device) });
            await rotateTokenIfDue(db, socket, device, claims, presented, reqLogger);
            // Les modules (CloudSync) poussent leurs assignations et rattrapent
            // le retard éventuel.
            void Promise.resolve(hooks.onAgentConnect(deviceId)).catch((err: unknown) => {
                reqLogger.warn({ err }, 'Module onAgentConnect failed');
            });
            // A transient DB error must not tear down the fresh socket: an agent
            // retrying against a briefly unhealthy DB would become an
            // accept-then-close reconnect storm.
            try {
                await db.devices.touchSeen(deviceId, Math.floor(Date.now() / 1000));
                await recordAgentOnline(db, device, wasOnlineInHub);
            } catch (err) {
                reqLogger.warn({ err }, 'Connect-time presence bookkeeping failed (socket kept open)');
            }
            // `device.presence` ne part qu'aux abonnés d'un appareil précis ;
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
            hooks,
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
                // Journalisé, et pas seulement renvoyé à l'agent : sinon une
                // machine dont les trames ne valident plus paraît en ligne et
                // muette, sans indice.
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
            // promise is fire-and-forget: an unhandled rejection is fatal on
            // modern Node) nor take the socket down with it.
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
            // Une fermeture tardive d'un vieux socket (reconnexion rapide) ne doit
            // ni interrompre le nouveau, ni écrire un « offline » fantôme.
            if (!hub.isOnline(deviceId)) {
                hooks.onAgentOffline(deviceId);
                // Plus personne pour envoyer le `pkg.done` attendu : sans ça le
                // verrou survivrait à l'appareil.
                hub.failRunningUpgrades(deviceId, 'Agent déconnecté pendant la mise à jour');
                hub.failRunningDockerOp(deviceId, 'Agent déconnecté pendant l’action');
                if (device.status !== 'pending_deletion') {
                    void recordAgentOffline(db, deviceId).catch(() => {});
                }
                void notifyDeviceWorkspaces(db, live, deviceId).catch(() => {});
            }
            reqLogger.info('Agent disconnected');
        });
    });
}
