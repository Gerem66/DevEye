import type {
    AgentsFacade,
    DevEyeFacade,
    SdkAccountUsage,
    SdkCipher,
    SdkDevice,
    SdkProviders,
    SdkTelemetry
} from '@deveye/types/sdk/server';
import { FeatureError } from '@deveye/types/sdk/server';
import { MAIL_TRANSPORT_PROVIDER, type FeatureManifest, type NativeCapability } from '@deveye/types/sdk';
import type { MailTransportProvider } from '@deveye/types/sdk';
import type { DeviceRow, NotificationFeature } from '@deveye/types';

import { randomUUID } from 'node:crypto';

import type { Database } from '@/db';
import type { Logger } from 'pino';
import { authorizeDevice } from '@/agent/authorize';
import { metricIntervalOf, metricIntervalsOf } from '@/agent/cadence';
import { parseDeviceReport } from '@/agent/mappers';
import { editMessage, postMessage } from '@/Services/discord';
import { deliver, discordChannels, hasChannel, resolveChannelIds, resolveRoute } from '@/Services/notifications';
import { toSdkAccount } from './live';
import { pushAgentConfig, sdkDb, sdkHub } from './host';
import { agentDistDir, readServedManifestCached } from '@/agent/sync';

/**
 * La façade des natives : le seul chemin d'un module vers les données des
 * autres features. Chaque méthode vérifie d'abord que le manifest déclare la
 * capacité correspondante, ce qu'un administrateur lit avant d'installer.
 */
export interface FacadeDeps {
    db: Database;
    /** Cipher de l'étage ouvert de CET espace (résolu sans session côté services). */
    cipher: SdkCipher;
    workspaceId: number;
    /** L'appelant, ou 0 pour un service sans session. */
    userId: number;
    ownerUserId: number;
    /** L'appelant est administrateur global (false pour les services sessionless). */
    isAdmin: boolean;
    /** Le genre de l'espace : un administrateur dans son espace personnel voit la flotte. */
    workspaceKind: 'personal' | 'shared';
    manifest: FeatureManifest;
    logger: Logger;
    /** Les contrats nommés que l'hôte tient : c'est par eux que `mail` lit le module Mail. */
    providers: SdkProviders;
    /**
     * Lève `forbidden` si l'APPELANT ne tient pas ces permissions d'Appareils
     * sur cet appareil. Absent hors d'une commande : un service n'a pas
     * d'appelant dont éprouver les droits.
     */
    assertDeviceExtras?: (deviceId: string, extras: readonly string[]) => Promise<void>;
    /** Ce qu'utilisent ces comptes (`_quota.ts`), injecté pour ne pas lier la façade au registre. */
    accountUsages(userIds: readonly number[]): Promise<SdkAccountUsage[]>;
}

/** L'agent borne une action à 30 minutes ; le serveur l'attend un peu plus longtemps. */
const DOCKER_RUN_TIMEOUT_MS = 35 * 60_000;

/** Un inventaire se relève en quelques secondes ; au-delà, l'agent ne répondra plus. */
const DOCKER_INVENTORY_TIMEOUT_MS = 15_000;

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
                // Un canal dont le message vivant a conclu a déjà tout dit : lui
                // renvoyer l'avis en texte afficherait deux fois la même chose.
                const except = new Set(opts?.except ?? []);
                const channels = routed.filter((c) => !except.has(c.id));
                if (!hasChannel(channels)) return false;
                return deliver(
                    channels,
                    {
                        subject: alert.subject,
                        body: alert.body,
                        payload: alert.payload ?? { feature: deps.manifest.id },
                        // `deliver` ne s'en sert que sur un canal Discord ; le texte
                        // reste ce que reçoivent les autres.
                        embeds: alert.embeds ? [...alert.embeds] : undefined
                    },
                    deps.logger
                );
            },
            async liveChannels(opts) {
                gate('notify');
                const routed = await resolveRoute(deps.db, cipher, deps.workspaceId, feature, opts?.itemId);
                // Discord seul sait modifier ce qu'il a déjà envoyé
                // (`Services/discord.ts`).
                return discordChannels(routed).map((c) => ({ id: c.id }));
            },
            async postLive(channelId, message, messageId) {
                gate('notify');
                // Un canal de la feature du module, dans son espace : la
                // résolution par identifiant ignore la feature, d'où la relecture.
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
                // Le contrat du module Mail : les expéditeurs prêts, comptes de
                // l'étage ouvert et actifs. Sans module Mail, aucun.
                const transport = deps.providers.get<MailTransportProvider>(MAIL_TRANSPORT_PROVIDER);
                if (!transport) return [];
                return transport.listSenders(deps.workspaceId);
            }
        },
        accounts: {
            async me() {
                gate('accounts.read');
                const row = deps.userId ? await deps.db.users.findById(deps.userId) : null;
                if (!row) throw new FeatureError('not_found', 'Compte introuvable');
                return toSdkAccount(row);
            }
        },
        usage: {
            async of(userId) {
                gate('accounts.usage');
                if (userId !== deps.userId && !deps.isAdmin) {
                    throw new FeatureError('forbidden', 'Réservé à l’administrateur');
                }
                const [found] = await deps.accountUsages([userId]);
                if (!found) throw new FeatureError('not_found', 'Compte introuvable');
                return found;
            },
            async ofMany(userIds) {
                gate('accounts.usage');
                if (!deps.isAdmin) throw new FeatureError('forbidden', 'Réservé à l’administrateur');
                return deps.accountUsages(userIds);
            }
        },
        workspaces: {
            async list() {
                gate('workspaces.read');
                // La capacité dit ce que le module peut demander ; l'appelant doit
                // encore être l'administrateur global.
                if (!deps.isAdmin) throw new FeatureError('forbidden', 'Réservé à l’administrateur');
                const rows = await deps.db.workspaces.listAll();
                return rows.map((w) => ({ id: w.id, name: w.name, kind: w.kind, ownerUserId: w.owner_user_id }));
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
                    // Vide sur un compte jamais colorié : `null`, et l'appelant
                    // retombe sur `defaultUserColor`, comme l'app.
                    color: u.color || null
                }));
            }
        },
        devices: {
            // La garde unique des appareils (`agent/authorize.ts`), celle du
            // transport et de la feature.
            async authorize(deviceId, options) {
                gate('devices.read');
                const row = await authorizeDevice(deps, deviceId);
                const device = toSdkDevice(row, await metricIntervalOf(deps.db, row));
                const extras = options?.extras ?? [];
                if (extras.length > 0) {
                    if (!deps.assertDeviceExtras) {
                        throw new FeatureError(
                            'forbidden',
                            'Une permission sur un appareil se vérifie depuis une commande'
                        );
                    }
                    await deps.assertDeviceExtras(device.id, extras);
                }
                return device;
            },
            // Une seule règle : les appareils de l'espace actif, les siens et
            // ceux qui y sont projetés.
            async list() {
                gate('devices.read');
                const rows = await deps.db.devices.listByWorkspace(deps.workspaceId);
                const intervals = await metricIntervalsOf(deps.db, rows);
                return rows.map((row) => toSdkDevice(row, intervals.get(row.id) as number));
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
export function toSdkDevice(row: DeviceRow, effectiveMetricIntervalSeconds: number): SdkDevice {
    return {
        id: row.id,
        name: row.name,
        online: sdkHub().isOnline(row.id),
        status: row.status,
        ownerUserId: row.owner_id,
        workspaceId: row.workspace_id,
        metricIntervalSeconds: row.metric_interval_seconds === null ? null : Number(row.metric_interval_seconds),
        effectiveMetricIntervalSeconds,
        report: parseDeviceReport(row.report_json)
    };
}

/**
 * La télémétrie des appareils, lue à l'instant (la liste de processus la plus
 * proche et sa ligne de métriques), et l'épinglage d'un instant pour que la
 * rétention n'efface jamais la preuve d'un constat.
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
            // épinglée perd sa liste de processus à la purge suivante.
            await db.metrics.setInstantsPinned(deviceId, ts, ts, true);
        }
    };
}

/**
 * La façade agents : chaque appel vérifie la capacité puis délègue au hub,
 * résolu à l'invocation (il se dépose au boot, après le chargement des modules).
 */
export function agentsFacade(gate: () => void): AgentsFacade {
    return {
        isOnline: (deviceId) => (gate(), sdkHub().isOnline(deviceId)),
        requestScan: (deviceId) => (gate(), sdkHub().requestScan(deviceId)),
        pushConfig: (deviceId) => (gate(), pushAgentConfig(deviceId)),
        metricIntervals: (devices) => (gate(), metricIntervalsOf(sdkDb(), devices)),
        requestDestroy: (deviceId) => (gate(), sdkHub().requestDestroy(deviceId)),
        disconnectAgent: (deviceId) => (gate(), sdkHub().disconnectAgent(deviceId)),
        // Le manifest des binaires servis ; la distribution elle-même reste à l'app.
        servedManifest: () => (gate(), readServedManifestCached(agentDistDir())),
        requestSyncConfig: (deviceId, payload) => (gate(), sdkHub().requestSyncConfig(deviceId, payload)),
        requestSyncScan: (deviceId, payload) => (gate(), sdkHub().requestSyncScan(deviceId, payload)),
        requestSyncPush: (deviceId, payload) => (gate(), sdkHub().requestSyncPush(deviceId, payload)),
        requestSyncPushAck: (deviceId, payload) => (gate(), sdkHub().requestSyncPushAck(deviceId, payload)),
        requestSyncApplyChunk: (deviceId, payload) => (gate(), sdkHub().requestSyncApplyChunk(deviceId, payload)),
        requestSyncApplyStart: (deviceId, payload) => (gate(), sdkHub().requestSyncApplyStart(deviceId, payload)),
        requestSyncApplyDir: (deviceId, payload) => (gate(), sdkHub().requestSyncApplyDir(deviceId, payload)),
        requestSyncApplyLocal: (deviceId, payload) => (gate(), sdkHub().requestSyncApplyLocal(deviceId, payload)),
        requestSyncMove: (deviceId, payload) => (gate(), sdkHub().requestSyncMove(deviceId, payload)),
        requestSyncDelete: (deviceId, payload) => (gate(), sdkHub().requestSyncDelete(deviceId, payload)),
        publishSyncProgress: (payload) => (gate(), sdkHub().publishSyncProgress(payload)),
        publishSyncState: (payload) => (gate(), sdkHub().publishSyncState(payload)),
        // Les ordres de fichiers de l'explorateur : ce qui fait d'une machine
        // enrôlée une destination de sauvegarde.
        requestFilesMutate: (deviceId, payload) => (gate(), sdkHub().requestFilesMutate(deviceId, payload)),
        requestFilesUpload: (deviceId, payload) => (gate(), sdkHub().requestFilesUpload(deviceId, payload)),
        awaitFilesOp: (opId, timeoutMs) => (gate(), sdkHub().awaitFilesOp(opId, timeoutMs)),
        cancelFilesOp: (opId) => (gate(), sdkHub().cancelFilesOp(opId)),
        buffered: (deviceId) => (gate(), sdkHub().agentBuffered(deviceId)),
        // Le déploiement par une machine : l'action attendue hors socket, et
        // l'inventaire qui en propose les services.
        dockerRun: (deviceId, order, options) => (
            gate(),
            sdkHub().runDockerOp(
                deviceId,
                { opId: randomUUID(), ...order },
                { timeoutMs: options?.timeoutMs ?? DOCKER_RUN_TIMEOUT_MS, onLine: options?.onLine }
            )
        ),
        dockerInventory: (deviceId, timeoutMs) => (
            gate(),
            sdkHub().awaitDockerInventory(deviceId, timeoutMs ?? DOCKER_INVENTORY_TIMEOUT_MS)
        ),
        // La sauvegarde d'un dossier d'une machine : l'archive faite par l'agent,
        // tirée au rythme du consommateur.
        archiveFolder: (deviceId, request, options) => (
            gate(),
            sdkHub().openFolderArchive(
                deviceId,
                {
                    opId: randomUUID(),
                    path: request.path,
                    exclusions: [...request.exclusions],
                    oneFileSystem: request.oneFileSystem
                },
                options?.signal
            )
        ),
        openTcp: (deviceId, target) => (gate(), sdkHub().tunnels.open(deviceId, target))
    };
}
