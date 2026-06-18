import type { WebSocket } from '@fastify/websocket';
import { randomUUID } from 'crypto';
import { clientMessageSchema, err, ok, type ServerMessage } from 'deveye-types';
import type { FastifyInstance } from 'fastify';

import { ACCESS_COOKIE } from '@/auth/cookies';
import { verifyAccessToken } from '@/auth/jwt';
import { createMonitorTransport, type MonitorHub } from '@/agent/hub';
import { FeatureError } from '@/features/_define';
import { forgetReveal } from '@/features/note/_shared';
import { forgetSession } from '@/features/password/_shared';
import { featureHandlerMap } from '@/features/registry';
import { createSecureStore, forgetSessionDek } from '@/Services/SecureStore';
import { logger } from '@/logger';

import type { Database } from '@/db';
import type Encryption from '@/Services/Encryption';

interface WSDeps {
    db: Database;
    crypt: Encryption;
    hub: MonitorHub;
}

interface Session {
    userId: number;
    sessionId: string;
}

function send(socket: WebSocket, msg: ServerMessage): void {
    socket.send(JSON.stringify(msg));
}

export async function registerWS(app: FastifyInstance, { db, crypt, hub }: WSDeps): Promise<void> {
    app.get('/ws', { websocket: true }, async (socket, req) => {
        const accessToken = req.cookies[ACCESS_COOKIE];
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

        const { store: secure, keys: secretKeys } = createSecureStore(db, crypt, session.userId, session.sessionId);

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

            const { command, payload, requestId: clientReqId } = parsed.data;
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

            try {
                const result = await def.handler(
                    {
                        db,
                        crypt,
                        secure,
                        secretKeys,
                        userId: session!.userId,
                        sessionId: session!.sessionId,
                        logger: reqLogger.child({ command, requestId: replyId }),
                        requestId: replyId,
                        monitor
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
            }
        });

        socket.on('close', () => {
            hub.dropSubscriber(socket);
            forgetSession(session!.sessionId);
            forgetSessionDek(session!.sessionId);
            forgetReveal(session!.sessionId);
            reqLogger.info('WS closed');
        });
    });
}
