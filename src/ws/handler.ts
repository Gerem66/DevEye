import type { WebSocket } from '@fastify/websocket';
import { randomUUID } from 'crypto';
import {
    clientMessageSchema,
    err,
    LIVE_CURSOR_COMMAND,
    LIVE_TYPING_COMMAND,
    liveCursorFrameSchema,
    liveTypingFrameSchema,
    ok,
    type FeatureAccess,
    type ServerMessage,
    type WorkspaceCapability,
    type FeatureId,
    liveTopicSchema
} from '@deveye/types';
import type { FastifyInstance } from 'fastify';

import { ACCESS_COOKIE } from '@/auth/cookies';
import { verifyAccessToken } from '@/auth/jwt';
import { createMonitorTransport, type MonitorHub } from '@/agent/hub';
import { accessEpochNow, createAccessResolver } from '@/features/_access';
import type { LiveHub } from '@/live/hub';
import { FeatureError } from '@/features/_define';
import { featureHandlerMap } from '@/features/registry';
import { topicsOf } from '@/features/_topics';
import { enterSessionCommand, exitSessionCommand, forgetSessionDek } from '@/Services/SecureStore';
import { logger } from '@/logger';

import type { Database } from '@/db';
import type Encryption from '@/Services/Encryption';
import type { AuditLog } from '@/Services/AuditLog';
import type { FeatureAuditEntry } from '@/features/_define';

interface WSDeps {
    db: Database;
    crypt: Encryption;
    hub: MonitorHub;
    live: LiveHub;
    audit: AuditLog;
}

interface Session {
    userId: number;
    sessionId: string;
}

function send(socket: WebSocket, msg: ServerMessage): void {
    socket.send(JSON.stringify(msg));
}

/**
 * Les espaces qui voient l'appareil visé par cette commande, s'il y en a un.
 *
 * Lu sur la charge brute plutôt que sur l'entrée validée : l'appel doit pouvoir
 * se faire *avant* que le handler ne tourne, et un `deviceId` qui ne serait pas
 * un identifiant valide ne rend simplement rien. Vide pour toute commande qui ne
 * parle pas d'un appareil, donc pour l'immense majorité d'entre elles.
 */
async function deviceWorkspacesOf(db: Database, command: string, payload: unknown): Promise<number[]> {
    if (!command.startsWith('agent.') && !command.startsWith('devices.')) return [];
    const deviceId = (payload as { deviceId?: unknown } | null)?.deviceId;
    if (typeof deviceId !== 'string' || deviceId.length === 0) return [];
    return db.devices.workspaceIdsOf(deviceId);
}

function unionWorkspaces(a: readonly number[], b: readonly number[]): number[] {
    return [...new Set([...a, ...b])];
}

export async function registerWS(
    app: FastifyInstance,
    { db, crypt, hub, live: liveHub, audit }: WSDeps
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

        // Inscrite dès la poignée de main, avant tout `live.here` : sans ça le
        // battement de cœur ne couvrirait que les utilisateurs ayant ouvert une
        // vue instrumentée, et les sockets zombies des autres passeraient au
        // travers. Entrer dans une *salle* reste conditionné à `live.here`.
        const live = liveHub.register(socket, session.userId, session.sessionId);

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

            // Voie rapide des curseurs, avant la recherche de commande.
            //
            // À ~20 Hz, ce qui suit coûterait par mouvement : la validation zod
            // de l'entrée, l'allocation de la fermeture d'audit, un ticket DEK,
            // la résolution asynchrone du scope, six fermetures de garde, la
            // validation de sortie — et une trame de réponse dont personne
            // n'attend rien.
            //
            // L'espace annoncé par l'enveloppe est **ignoré** ici : il n'est
            // validé que par `access.forWorkspace()`, que cette voie
            // court-circuite. Seule la salle posée par un `live.here` — passé,
            // lui, par tout le pipeline — fait foi. La trame ne porte donc que
            // des coordonnées, jamais un lieu.
            if (command === LIVE_CURSOR_COMMAND) {
                const frame = liveCursorFrameSchema.safeParse(payload);
                if (frame.success) liveHub.cursor(socket, frame.data.cursor);
                return;
            }

            // Même voie rapide, mêmes raisons, pour « en train d'écrire » : une
            // trame sans réponse ni audit, dont le lieu vient du dernier
            // `live.here` et jamais de l'enveloppe.
            if (command === LIVE_TYPING_COMMAND) {
                const frame = liveTypingFrameSchema.safeParse(payload);
                if (frame.success) liveHub.typing(socket, frame.data.typing);
                return;
            }

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
            // category defaults to the command's prefix (e.g. `notes` for
            // `notes.add`) so handlers usually only describe the event.
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

            // Les espaces qui voient cet appareil *avant* que la commande ne
            // tourne — la seule occasion de les connaître quand elle les efface.
            const sharedBefore = await deviceWorkspacesOf(db, command, payload);

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

                // Les droits résolus sont confiés au hub de présence, qui filtre
                // ses diffusions dessus. Les y déposer ici plutôt que de les
                // faire re-résoudre au moment de diffuser garde la diffusion
                // entièrement synchrone — et fait que n'importe quelle commande
                // répare un instantané périmé.
                const epoch = accessEpochNow();
                liveHub.rememberGrants(socket, scope.workspace.id, scope.features, epoch);
                // Même dépôt pour le hub de supervision, et pour la même raison :
                // sa diffusion (métriques, rapports, sortie de terminal, morceaux
                // de fichiers) doit pouvoir se refuser sans rien attendre. Un
                // administrateur garde le droit — la page Appareils porte sur la
                // flotte entière, hors de tout rôle d'espace.
                hub.rememberGrants(socket, scope.isAdmin || scope.features.has('devices'), epoch);

                const assertAdmin = (): void => {
                    if (!scope.isAdmin) throw new FeatureError('forbidden', 'Réservé aux administrateurs');
                };
                const can = (c: WorkspaceCapability): boolean => scope.capabilities.has(c);
                const assertCan = (c: WorkspaceCapability): void => {
                    if (!can(c)) throw new FeatureError('forbidden', 'Droit insuffisant sur cet espace');
                };
                // `write` implique `read` : une seule comparaison suffit.
                const canFeature = (f: FeatureId, level: FeatureAccess = 'read'): boolean => {
                    const granted = scope.features.get(f);
                    if (!granted) return false;
                    return level === 'read' || granted === 'write';
                };
                const assertFeature = (f: FeatureId, level: FeatureAccess = 'read'): void => {
                    if (!canFeature(f, level)) {
                        throw new FeatureError('forbidden', 'Cette fonctionnalité ne vous est pas ouverte ici');
                    }
                };
                // La lecture de la feature est incluse : gérer les destinations
                // d'une fonctionnalité qu'on ne voit pas n'a pas de sens.
                const canChannels = (f: FeatureId): boolean => canFeature(f) && scope.channels.has(f);
                const assertChannels = (f: FeatureId): void => {
                    if (!canChannels(f)) {
                        throw new FeatureError(
                            'forbidden',
                            'La gestion des canaux de cette fonctionnalité ne vous est pas confiée'
                        );
                    }
                };
                const assertItem = async (
                    f: FeatureId,
                    itemId: number,
                    level: FeatureAccess = 'read'
                ): Promise<void> => {
                    // La feature d'abord : une restriction d'élément ne peut
                    // qu'abaisser, jamais ouvrir ce que la feature ferme.
                    assertFeature(f, level);
                    const restriction = (await scope.itemRestrictions(f)).get(itemId);
                    if (restriction === 'none') {
                        throw new FeatureError('forbidden', 'Cet élément ne vous est pas accessible');
                    }
                    if (restriction === 'read' && level === 'write') {
                        throw new FeatureError('forbidden', 'Cet élément est en lecture seule pour votre rôle');
                    }
                };

                // Declared authorization (see `FeatureAccessSpec`), enforced here
                // so a command can never ship without its guard.
                if (def.access?.admin) assertAdmin();
                if (def.access?.feature) assertFeature(def.access.feature, def.access.level);
                for (const c of def.access?.capabilities ?? []) assertCan(c);

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
                        can,
                        assertCan,
                        canFeature,
                        assertFeature,
                        canChannels,
                        assertChannels,
                        itemRestrictions: scope.itemRestrictions,
                        assertItem,
                        extrasFor: (f) => scope.extras.get(f) ?? {},
                        ip,
                        logger: reqLogger.child({ command, requestId: replyId }),
                        requestId: replyId,
                        audit: recordAudit,
                        monitor,
                        live
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

                // La commande a écrit : l'espace en est averti, et toute vue qui
                // lit ce sujet se remet à jour d'elle-même.
                //
                // Posé ici — après la réponse, dans le `try` — et non dans le
                // `finally` : une commande qui a échoué n'invalide rien. La
                // sortie vers `auditWorkspaceId` (et jamais vers l'espace de
                // l'enveloppe) est ce qui rend `scope: 'account'` correct :
                // `secrecy.enable` émis depuis un espace partagé n'avertit que
                // l'espace **personnel** de l'appelant.
                //
                // L'émetteur est exclu : il tient déjà sa propre réponse.
                let topics = topicsOf(command);
                let extraWorkspace: number | null = null;
                // Les commandes de partage portent leur fonctionnalité en
                // ENTRÉE : leur préfixe ne peut pas dire quel sujet diffuser.
                // On le lit dans la requête — le sujet d'une feature branchée
                // au partage porte le même nom qu'elle — et on prévient aussi
                // l'espace visé : après un retrait, la table ne le relie plus,
                // donc l'éventail des projections ne le trouverait pas.
                if (topics && command.startsWith('share.')) {
                    const body = inputParse.data as { feature?: string; workspaceId?: number };
                    const asTopic = liveTopicSchema.safeParse(body.feature);
                    if (asTopic.success) topics = [...topics, asTopic.data];
                    extraWorkspace = body.workspaceId ?? null;
                }
                if (topics) {
                    liveHub.changed(auditWorkspaceId, topics, session!.userId, socket);
                    if (extraWorkspace !== null && extraWorkspace !== auditWorkspaceId) {
                        liveHub.changed(extraWorkspace, topics, session!.userId);
                    }
                    // Un appareil est partageable entre plusieurs espaces, et le
                    // dispatcheur ne connaît que celui de l'enveloppe : sans cet
                    // éventail, les autres destinataires resteraient sur une
                    // liste figée — présence, renommage, configuration, tout
                    // leur échapperait jusqu'au rechargement.
                    //
                    // L'union avant/après est nécessaire dans les deux sens :
                    // `devices.delete` efface les rattachements (seul « avant »
                    // les connaît), `devices.setWorkspaces` en crée (seul
                    // « après » les voit).
                    for (const wid of unionWorkspaces(sharedBefore, await deviceWorkspacesOf(db, command, payload))) {
                        if (wid !== auditWorkspaceId) liveHub.changed(wid, topics, session!.userId);
                    }
                }
            } catch (e) {
                // Le duck-typing double l'instanceof exprès : si un module et
                // l'app résolvent deux instances distinctes de @deveye/types
                // (miroir node_modules d'un côté, alias de l'autre), l'erreur
                // typée d'un module resterait sinon un `internal` opaque.
                if (!(e instanceof FeatureError) && e instanceof Error && e.name === 'FeatureError' && 'code' in e) {
                    const dup = e as Error & { code: string; details?: unknown };
                    reqLogger.warn({ command, code: dup.code, msg: dup.message }, 'Feature error');
                    send(socket, {
                        requestId: replyId,
                        command,
                        payload: err(dup.code as Parameters<typeof err>[0], dup.message, dup.details)
                    });
                    return;
                }
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
            liveHub.drop(socket);
            forgetSessionDek(session!.sessionId);
            reqLogger.info('WS closed');
        });
    });
}
