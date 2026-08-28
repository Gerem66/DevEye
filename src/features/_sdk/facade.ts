import type {
    AgentsFacade,
    DevEyeFacade,
    SdkCipher,
    SdkDevice,
    SdkProviders,
    SdkTelemetry
} from '@deveye/types/sdk/server';
import { FeatureError } from '@deveye/types/sdk/server';
import { MAIL_TRANSPORT_PROVIDER, type FeatureManifest, type NativeCapability } from '@deveye/types/sdk';
import type { MailTransportProvider } from '@deveye/types/sdk';
import type { DeviceRow, NotificationFeature } from '@deveye/types';

import type { Database } from '@/db';
import type { Logger } from 'pino';
import { authorizeDevice } from '@/agent/authorize';
import { parseDeviceReport } from '@/agent/mappers';
import { editMessage, postMessage } from '@/Services/discord';
import { deliver, discordChannels, hasChannel, resolveChannelIds, resolveRoute } from '@/Services/notifications';
import { pushAgentConfig, sdkHub } from './host';

/**
 * La façade des natives : le SEUL chemin d'un module vers les données des
 * autres features. Chaque méthode vérifie d'abord que le manifest déclare la
 * capacité correspondante : la déclaration n'est pas une politesse, c'est ce
 * qu'un administrateur lit avant d'installer le module.
 */
export interface FacadeDeps {
    db: Database;
    /** Cipher de l'étage ouvert de CET espace (résolu sans session côté services). */
    cipher: SdkCipher;
    workspaceId: number;
    ownerUserId: number;
    /** L'appelant est administrateur global (false pour les services sessionless). */
    isAdmin: boolean;
    /** Le genre de l'espace : un administrateur dans son espace personnel voit la flotte. */
    workspaceKind: 'personal' | 'shared';
    manifest: FeatureManifest;
    logger: Logger;
    /** Les contrats nommés que l'hôte tient : c'est par eux que `mail` lit le module Mail. */
    providers: SdkProviders;
}

export function createFacade(deps: FacadeDeps): DevEyeFacade {
    const declared = new Set<NativeCapability>(deps.manifest.nativeCapabilities ?? []);
    const gate = (cap: NativeCapability): void => {
        if (!declared.has(cap)) {
            throw new FeatureError('forbidden', `Declare '${cap}' in the manifest's nativeCapabilities`);
        }
    };
    // `resolveRoute` attend le Cipher de l'app ; le SdkCipher lui est
    // structurellement identique (trois méthodes sur des chaînes).
    const cipher = deps.cipher as Parameters<typeof resolveRoute>[1];
    const feature = deps.manifest.id as NotificationFeature;

    return {
        notify: {
            async hasRoute(itemId) {
                gate('notify');
                return hasChannel(await resolveRoute(deps.db, cipher, deps.workspaceId, feature, itemId));
            },
            async send(alert, opts) {
                gate('notify');
                const routed = await resolveRoute(deps.db, cipher, deps.workspaceId, feature, opts?.itemId);
                // Un canal dont le message vivant a conclu a déjà tout dit :
                // lui renvoyer l'avis en texte afficherait deux fois la même
                // chose (le suivi d'un déploiement).
                const except = new Set(opts?.except ?? []);
                const channels = routed.filter((c) => !except.has(c.id));
                if (!hasChannel(channels)) return false;
                return deliver(
                    channels,
                    {
                        subject: alert.subject,
                        body: alert.body,
                        payload: alert.payload ?? { feature: deps.manifest.id },
                        // La mise en page Discord du module, quand il en a une :
                        // `deliver` ne s'en sert que sur un canal Discord, le
                        // texte reste ce que reçoivent les autres.
                        embeds: alert.embeds ? [...alert.embeds] : undefined
                    },
                    deps.logger
                );
            },
            async liveChannels(opts) {
                gate('notify');
                const routed = await resolveRoute(deps.db, cipher, deps.workspaceId, feature, opts?.itemId);
                // Discord seul sait modifier ce qu'il a déjà envoyé (voir
                // `Services/discord.ts`) : ce sont les canaux d'un message qui
                // se met à jour du début à la fin.
                return discordChannels(routed).map((c) => ({ id: c.id }));
            },
            async postLive(channelId, message, messageId) {
                gate('notify');
                // Un canal de LA feature du module, dans SON espace : la
                // résolution par identifiant ignore la feature, la ligne est
                // relue pour la vérifier avant de publier quoi que ce soit.
                const row = await deps.db.notificationChannels.findById(channelId, deps.workspaceId);
                if (!row || row.feature !== feature) return null;
                const [channel] = discordChannels(
                    await resolveChannelIds(deps.db, cipher, deps.workspaceId, [channelId])
                );
                if (!channel?.webhookUrl) return null;
                const body = { content: message.content, embeds: message.embeds ? [...message.embeds] : undefined };
                if (messageId) {
                    return (await editMessage(channel.webhookUrl, messageId, body, deps.logger)) ? messageId : null;
                }
                return postMessage(channel.webhookUrl, body, deps.logger);
            }
        },
        mail: {
            async listAccounts() {
                gate('mail.accounts');
                // Le contrat du module Mail (`MAIL_TRANSPORT_PROVIDER`), le même
                // que lit `Services/notifications.ts` : les expéditeurs prêts,
                // c'est-à-dire les comptes de l'étage ouvert (un compte gardé
                // n'est pas lisible sans session, et un module n'a pas à
                // savoir qu'il existe) et actifs. Sans module Mail, aucun.
                const transport = deps.providers.get<MailTransportProvider>(MAIL_TRANSPORT_PROVIDER);
                if (!transport) return [];
                return transport.listSenders(deps.workspaceId);
            }
        },
        members: {
            async list() {
                gate('members.read');
                const rows = await deps.db.workspaceMembers.listByWorkspaceIds([deps.workspaceId]);
                const ids = [...new Set([deps.ownerUserId, ...rows.map((r) => r.user_id)])];
                const users = await deps.db.users.findByIds(ids);
                return users.map((u) => ({
                    userId: u.id,
                    name: u.username,
                    isOwner: u.id === deps.ownerUserId,
                    // La couleur du compte, celle de sa présence en direct :
                    // un module qui montre une personne la montre de la même
                    // couleur que partout ailleurs. Vide sur un compte jamais
                    // colorié : `null`, et l'appelant retombe sur
                    // `defaultUserColor`, comme l'app.
                    color: u.color || null
                }));
            }
        },
        devices: {
            // La garde unique des appareils (`agent/authorize.ts`), celle du
            // transport et de la feature : la ligne doit exister ET appartenir
            // à CET espace, l'admin global passant outre l'appartenance. Elle
            // ne demande que la base, l'espace et le statut, ce que la façade
            // porte sans session ni socket.
            async authorize(deviceId) {
                gate('devices.read');
                return toSdkDevice(await authorizeDevice(deps, deviceId));
            },
            // Même règle que `devices.list` : l'administrateur dans son espace
            // PERSONNEL voit la flotte entière (c'est là qu'il surveille ses
            // machines, et l'obliger à se partager chaque appareil à lui-même
            // n'aurait rien protégé) ; partout ailleurs, le partage explicite.
            async list() {
                gate('devices.read');
                const rows =
                    deps.isAdmin && deps.workspaceKind === 'personal'
                        ? await deps.db.devices.listAll()
                        : await deps.db.devices.listByWorkspace(deps.workspaceId);
                return rows.map(toSdkDevice);
            },
            isOnline(deviceId) {
                gate('devices.read');
                return sdkHub().isOnline(deviceId);
            }
        },
        telemetry: createTelemetry(deps.db, () => gate('telemetry.read')),
        agents: agentsFacade(() => gate('agents'))
    };
}

/** Ce que la façade révèle d'une ligne appareil : l'identité, l'état, le rapport. */
export function toSdkDevice(row: DeviceRow): SdkDevice {
    return {
        id: row.id,
        name: row.name,
        online: sdkHub().isOnline(row.id),
        status: row.status,
        ownerUserId: row.owner_id,
        workspaceId: row.workspace_id ?? null,
        metricIntervalSeconds: row.metric_interval_seconds === null ? null : Number(row.metric_interval_seconds),
        report: parseDeviceReport(row.report_json)
    };
}

/**
 * La télémétrie des appareils, lue à l'instant : la liste de processus la plus
 * proche et la ligne de métriques qui l'accompagne, exactement ce que le moteur
 * Sentinelle lisait en dur. Et l'épinglage d'un instant, pour que la rétention
 * n'efface jamais la preuve d'un constat.
 */
export function createTelemetry(db: Database, gate: () => void): SdkTelemetry {
    return {
        async snapshot(deviceId, ts) {
            gate();
            const sample = await db.processSamples.nearest(deviceId, ts);
            const points = await db.metrics.query({ deviceId, from: ts - 1000, to: ts + 1000, resolution: 'raw' });
            const point = points[points.length - 1] ?? null;
            if (!sample && !point) return null;
            return {
                ts,
                processes: sample?.processes ?? [],
                activeConnections: point?.activeConnections ?? null
            };
        },
        async pinInstant(deviceId, ts) {
            gate();
            // Les deux tables en une seule instruction : une preuve à moitié
            // épinglée est une preuve dont la liste de processus disparaît à
            // la purge suivante.
            await db.metrics.setInstantsPinned(deviceId, ts, ts, true);
        }
    };
}

/**
 * La façade agents : chaque appel vérifie la capacité puis délègue au hub,
 * résolu à l'invocation (le hub se dépose au boot, après le chargement des
 * modules). Noms et sémantique du hub, à l'identique : c'est ce qui a permis
 * au moteur rapatrié de troquer sa poignée sans changer une ligne de logique.
 */
export function agentsFacade(gate: () => void): AgentsFacade {
    return {
        isOnline: (deviceId) => (gate(), sdkHub().isOnline(deviceId)),
        requestScan: (deviceId) => (gate(), sdkHub().requestScan(deviceId)),
        pushConfig: (deviceId) => (gate(), pushAgentConfig(deviceId)),
        requestDestroy: (deviceId) => (gate(), sdkHub().requestDestroy(deviceId)),
        disconnectAgent: (deviceId) => (gate(), sdkHub().disconnectAgent(deviceId)),
        resetAgentSession: (deviceId) => (gate(), sdkHub().resetAgentSession(deviceId)),
        requestSyncConfig: (deviceId, payload) => (gate(), sdkHub().requestSyncConfig(deviceId, payload)),
        requestSyncScan: (deviceId, payload) => (gate(), sdkHub().requestSyncScan(deviceId, payload)),
        requestSyncPush: (deviceId, payload) => (gate(), sdkHub().requestSyncPush(deviceId, payload)),
        requestSyncApplyChunk: (deviceId, payload) => (gate(), sdkHub().requestSyncApplyChunk(deviceId, payload)),
        requestSyncApplyStart: (deviceId, payload) => (gate(), sdkHub().requestSyncApplyStart(deviceId, payload)),
        requestSyncApplyDir: (deviceId, payload) => (gate(), sdkHub().requestSyncApplyDir(deviceId, payload)),
        requestSyncApplyLocal: (deviceId, payload) => (gate(), sdkHub().requestSyncApplyLocal(deviceId, payload)),
        requestSyncMove: (deviceId, payload) => (gate(), sdkHub().requestSyncMove(deviceId, payload)),
        requestSyncDelete: (deviceId, payload) => (gate(), sdkHub().requestSyncDelete(deviceId, payload)),
        publishSyncProgress: (payload) => (gate(), sdkHub().publishSyncProgress(payload)),
        publishSyncState: (payload) => (gate(), sdkHub().publishSyncState(payload)),
        // Les ordres de fichiers de l'explorateur, offerts tels quels : c'est
        // ce qui fait d'une machine enrôlée une destination de sauvegarde
        // sans rien changer à l'agent.
        requestFilesMutate: (deviceId, payload) => (gate(), sdkHub().requestFilesMutate(deviceId, payload)),
        requestFilesUpload: (deviceId, payload) => (gate(), sdkHub().requestFilesUpload(deviceId, payload)),
        awaitFilesOp: (opId, timeoutMs) => (gate(), sdkHub().awaitFilesOp(opId, timeoutMs)),
        cancelFilesOp: (opId) => (gate(), sdkHub().cancelFilesOp(opId)),
        buffered: (deviceId) => (gate(), sdkHub().agentBuffered(deviceId))
    };
}
