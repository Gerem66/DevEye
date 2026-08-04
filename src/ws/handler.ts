import type { WebSocket } from '@fastify/websocket';
import { randomUUID } from 'crypto';
import { clientMessageSchema, err, ok, type ServerMessage } from 'deveye-types';
import type { FastifyInstance } from 'fastify';

import { ACCESS_COOKIE } from '@/auth/cookies';
import { verifyAccessToken } from '@/auth/jwt';
import { createMonitorTransport, type MonitorHub } from '@/agent/hub';
import { createAccessResolver } from '@/features/_access';
import { FeatureError } from '@/features/_define';
import { forgetSession } from '@/features/password/_shared';
import { featureHandlerMap } from '@/features/registry';
import { enterSessionCommand, exitSessionCommand, forgetSessionDek } from '@/Services/SecureStore';
import { logger } from '@/logger';

import type { CloudSyncEngine } from '@/cloudSync/engine';
import type { UptimeMonitor } from '@/Services/UptimeMonitor';
import type { Database } from '@/db';
import type Encryption from '@/Services/Encryption';
import type { AuditLog } from '@/Services/AuditLog';
import type { FeatureAuditEntry } from '@/features/_define';

interface WSDeps {
    db: Database;
    crypt: Encryption;
    hub: MonitorHub;
    cloudSync: CloudSyncEngine;
    uptime: UptimeMonitor;
    audit: AuditLog;
}

interface Session {
    userId: number;
    sessionId: string;
}

function send(socket: WebSocket, msg: ServerMessage): void {
    socket.send(JSON.stringify(msg));
}

export async function registerWS(
    app: FastifyInstance,
    { db, crypt, hub, cloudSync, uptime, audit }: WSDeps
): Promise<void> {
    app.get('/ws', { websocket: true }, async (socket, req) => {
        const accessToken = req.cookies[ACCESS_COOKIE];
        const ip = req.ip;
        let session: Session | null = null;

        if (accessToken) {
            const claims = await verifyAccessToken(accessToken);
            if (claims) {
                session = { userId: Number(claims.sub), sessionId: claims.sid };
            }
        }

        if (!session) {
            send(socket, {
                command: 'session',
                payload: err('auth_required', 'Authentication required')
            });
            socket.close(4401, 'unauthorized');
            return;
        }

        const reqLogger = logger.child({ userId: session.userId, sid: session.sessionId });
        reqLogger.info('WS connected');

        // Autorité unique sur ce que l'appelant peut faire et sur les clés de
        // chaque espace, mémoïsée pour la durée de la connexion et reconstruite
        // à la demande quand un accès est révoqué.
        const access = createAccessResolver(db, crypt, session.userId, session.sessionId);

        const monitor = createMonitorTransport(hub, socket);

        send(socket, { command: 'session', payload: ok({ userId: session.userId }) });

        socket.on('message', async (raw: Buffer) => {
            const requestId = randomUUID();
            let parsed;
            try {
                parsed = clientMessageSchema.safeParse(JSON.parse(raw.toString()));
            } catch {
                send(socket, {
                    requestId,
                    command: 'invalid',
                    payload: err('validation', 'Malformed JSON')
                });
                return;
            }

            if (!parsed.success) {
                send(socket, {
                    requestId,
                    command: 'invalid',
                    payload: err('validation', 'Invalid envelope', parsed.error.flatten())
                });
                return;
            }

            const { command, payload, requestId: clientReqId, workspaceId } = parsed.data;
            const replyId = clientReqId ?? requestId;

            const def = featureHandlerMap[command];
            if (!def) {
                send(socket, {
                    requestId: replyId,
                    command,
                    payload: err('not_found', `Unknown command: ${command}`)
                });
                return;
            }

            const inputParse = def.input.safeParse(payload);
            if (!inputParse.success) {
                send(socket, {
                    requestId: replyId,
                    command,
                    payload: err('validation', 'Invalid input', inputParse.error.flatten())
                });
                return;
            }

            // Per-request audit binding: actor, IP and channel are fixed here;
            // category defaults to the command's prefix (e.g. `note` for
            // `note.add`) so handlers usually only describe the event.
            //
            // L'espace est estampillé ici plutôt que par chaque handler : toute
            // ligne d'audit devient attribuable à un espace sans qu'aucune
            // feature n'ait à y penser. Renseigné dès la résolution du scope, il
            // reste absent des rares événements émis avant (aucun aujourd'hui).
            const defaultCategory = command.includes('.') ? command.slice(0, command.indexOf('.')) : command;
            let auditWorkspaceId: number | undefined;
            const recordAudit = (entry: FeatureAuditEntry): void => {
                audit.record({
                    level: entry.level,
                    source: 'web',
                    category: entry.category ?? defaultCategory,
                    action: entry.action,
                    uid: session!.userId,
                    ip,
                    description: entry.description,
                    metadata: { ...(entry.metadata ?? {}), workspaceId: auditWorkspaceId }
                });
            };

            // Bracket the call for single-use DEK accounting ("validate on every
            // action"): the unlocked DEK is wiped as soon as this command — and
            // any concurrent siblings unlocked alongside it — finish.
            const dekTicket = enterSessionCommand(session!.sessionId);
            try {
                // Une commande de compte ignore l'espace annoncé par l'enveloppe
                // et vise toujours l'espace personnel de l'appelant.
                const scope =
                    def.access?.scope === 'account'
                        ? await access.forAccount()
                        : await access.forWorkspace(workspaceId);
                auditWorkspaceId = scope.workspace.id;

                const assertAdmin = (): void => {
                    if (!scope.isAdmin) throw new FeatureError('forbidden', 'Réservé aux administrateurs');
                };
                // Declared authorization (see `FeatureAccessSpec`), enforced here
                // so a command can never ship without its guard.
                if (def.access?.admin) assertAdmin();

                const result = await def.handler(
                    {
                        db,
                        crypt,
                        secure: scope.secure,
                        secretKeys: scope.secretKeys,
                        userId: session!.userId,
                        sessionId: session!.sessionId,
                        workspace: scope.workspace,
                        workspaceId: scope.workspace.id,
                        isOwner: scope.isOwner,
                        isAdmin: scope.isAdmin,
                        assertAdmin,
                        ip,
                        logger: reqLogger.child({ command, requestId: replyId }),
                        requestId: replyId,
                        audit: recordAudit,
                        monitor,
                        cloudSync,
                        uptime
                    },
                    inputParse.data
                );
                const outputParse = def.output.safeParse(result);
                if (!outputParse.success) {
                    reqLogger.error({ command, err: outputParse.error.flatten() }, 'Handler returned invalid output');
                    send(socket, {
                        requestId: replyId,
                        command,
                        payload: err('internal', 'Internal output validation failure')
                    });
                    return;
                }
                send(socket, { requestId: replyId, command, payload: ok(outputParse.data) });
            } catch (e) {
                if (e instanceof FeatureError) {
                    reqLogger.warn({ command, code: e.code, msg: e.message }, 'Feature error');
                    send(socket, {
                        requestId: replyId,
                        command,
                        payload: err(e.code, e.message, e.details)
                    });
                    return;
                }
                reqLogger.error({ command, err: (e as Error).message }, 'Feature handler threw');
                send(socket, {
                    requestId: replyId,
                    command,
                    payload: err('internal', 'Internal server error')
                });
            } finally {
                exitSessionCommand(session!.sessionId, dekTicket);
            }
        });

        socket.on('close', () => {
            hub.dropSubscriber(socket);
            forgetSession(session!.sessionId);
            forgetSessionDek(session!.sessionId);
            reqLogger.info('WS closed');
        });
    });
}
