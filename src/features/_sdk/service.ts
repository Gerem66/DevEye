import type {
    DevEyeFacade,
    FeatureService,
    FeatureServiceDeps,
    SdkCipher,
    SdkProviders
} from '@deveye/types/sdk/server';
import type { FeatureManifest } from '@deveye/types/sdk';
import type { LiveTopic } from '@deveye/types';

import type { Database } from '@/db';
import type Encryption from '@/Services/Encryption';
import { FeatureError } from '@deveye/types/sdk/server';
import { accountChanged, toSdkAccount } from './live';
import { createQuota, modulePauses } from './quota';
import { serverKeysOf } from './host';
import { ORIGINS, publishFrame } from './context';
import { createOpenCipher, createSecureStore } from '@/Services/SecureStore';
import { verifyModuleTicket } from '@/auth/jwt';
import { maintenance } from '@/Services/maintenance';
import type { Logger } from 'pino';
import type { AuditLog } from '@/Services/AuditLog';
import type { LiveHub } from '@/live/hub';
import { agentsFacade, createFacade, createTelemetry, toSdkDevice } from './facade';
import { deviceVerdict, memberVerdict } from '../_access';
import { sdkFleetDomains } from './domains';
import { createFeatureStore } from './store';
import { sdkHub } from './host';

/**
 * Les dépendances d'un service d'arrière-plan de module : tout est résolu
 * SANS session, donc à l'étage ouvert exclusivement. Ce que l'étage gardé
 * exigerait n'existe simplement pas ici (voir `SessionlessFeatureStore`).
 */
export interface ModuleServiceHost {
    db: Database;
    crypt: Encryption;
    audit: AuditLog;
    logger: Logger;
    /** Un service écrit sans socket pour diffuser : c'est le hub qu'il avertit. */
    live: LiveHub;
}

/**
 * Alias de catégorie d'audit : la continuité des lignes persistées prime sur
 * la convention (les audits CloudSync portent `cloudSync`).
 */
const AUDIT_CATEGORY: Record<string, string> = { cloudsync: 'cloudSync' };

export function createServiceDeps(
    host: ModuleServiceHost,
    manifest: FeatureManifest,
    repo: unknown,
    providers: SdkProviders
): FeatureServiceDeps {
    const ciphers = new Map<number, SdkCipher>();
    const cipherFor = (workspaceId: number): SdkCipher => {
        const hit = ciphers.get(workspaceId);
        if (hit) return hit;
        // Mémoïsé par espace : un tick n'a pas à repayer la résolution de la
        // clé à chaque ligne.
        const cipher = createOpenCipher(host.db, host.crypt, workspaceId);
        ciphers.set(workspaceId, cipher);
        return cipher;
    };

    // La façade sessionless d'un espace, gardée par les capacités du manifest
    // comme dans une requête.
    const facades = new Map<number, DevEyeFacade>();
    const facadeFor = (workspaceId: number): DevEyeFacade => {
        const hit = facades.get(workspaceId);
        if (hit) return hit;
        const facade = createFacade({
            db: host.db,
            cipher: cipherFor(workspaceId),
            workspaceId,
            userId: 0,
            isAdmin: false,
            ownerUserId: 0,
            workspaceKind: 'shared',
            manifest,
            logger: host.logger,
            providers
        });
        facades.set(workspaceId, facade);
        return facade;
    };

    // La même erreur qu'en requête (`facade.ts`), nommant la capacité manquante.
    const capabilities = new Set(manifest.nativeCapabilities ?? []);
    const gate = (cap: 'agents' | 'devices.read' | 'telemetry.read' | 'accounts.read') => (): void => {
        if (!capabilities.has(cap)) {
            throw new FeatureError('forbidden', `Module « ${manifest.id} » : declare '${cap}' in nativeCapabilities`);
        }
    };
    const gateAgents = gate('agents');
    const gateDevices = gate('devices.read');
    const gateAccounts = gate('accounts.read');
    const keys = serverKeysOf(host.crypt, manifest.id);

    return {
        repo,
        listWorkspaceIds: async () => {
            const r = await host.db.queryable.query<{ id: number }>('SELECT id FROM workspaces ORDER BY id');
            return r.rows.map((row) => row.id);
        },
        // Variante sessionless du store : lire une ligne 'private' lève `locked`.
        storeFor: (workspaceId) =>
            createFeatureStore(host.db.featureKv, manifest.id, workspaceId, {
                open: cipherFor(workspaceId),
                guarded: null
            }),
        cipherFor,
        // Le ticket d'un module, rendu contre les codecs de son porteur : la
        // session est relue par l'hôte, et l'étage gardé n'est tendu que si
        // elle est encore déverrouillée.
        secrecy: {
            redeem: async (ticket) => {
                const claims = await verifyModuleTicket(manifest.id, ticket);
                if (!claims) return null;
                // Les routes réservées à l'app passent le filtre de maintenance :
                // pendant elle, leur ticket ne vaut plus que pour un administrateur.
                if (maintenance.siteDown() || maintenance.featureLevel(manifest.id) !== null) {
                    const holder = await host.db.users.findById(claims.userId);
                    if (holder?.role !== 'admin') return null;
                }
                const workspace = await host.db.workspaces.findById(claims.workspaceId);
                if (!workspace) return null;
                const { store } = createSecureStore(host.db, host.crypt, workspace, claims.sessionId);
                const unlocked = await store.isUnlocked().catch(() => false);
                return {
                    userId: claims.userId,
                    workspaceId: claims.workspaceId,
                    payload: claims.payload,
                    cipher: { server: cipherFor(claims.workspaceId), private: unlocked ? store : null }
                };
            }
        },
        origins: ORIGINS,
        domains: sdkFleetDomains(host.db, manifest),
        deveyeFor: (workspaceId) => ({ notify: facadeFor(workspaceId).notify }),
        // Relus à chaque appel : un droit retiré doit arrêter le travail suivant.
        access: {
            feature: (workspaceId, userId, need) => memberVerdict(host.db, userId, workspaceId, manifest.id, need),
            device: (workspaceId, userId, deviceId, extras) => {
                gateDevices();
                return deviceVerdict(host.db, userId, workspaceId, deviceId, extras);
            }
        },
        devicesFor: (workspaceId) => {
            const { list, isOnline } = facadeFor(workspaceId).devices;
            return { list, isOnline };
        },
        // La flotte entière, par identifiant, sans espace : pour un moteur qui
        // reçoit les trames de tous les appareils.
        devices: {
            find: async (deviceId) => {
                gateDevices();
                const row = await host.db.devices.findById(deviceId);
                return row ? toSdkDevice(row) : null;
            },
            isOnline: (deviceId) => (gateDevices(), sdkHub().isOnline(deviceId))
        },
        telemetry: createTelemetry(host.db, gate('telemetry.read')),
        live: {
            // Le sujet du module (son id), ou ceux que le service nomme : la même
            // règle que `mutates`, sans le filet du boot (un sujet inconnu n'a
            // simplement aucun abonné).
            changed: (workspaceId, topics) =>
                host.live.changed(workspaceId, (topics ?? [manifest.id]) as LiveTopic[], null),
            publish: (workspaceId, event, payload) => publishFrame(manifest, workspaceId, event, payload),
            accountChanged: (userId) => accountChanged(host.db, manifest, userId)
        },
        quotaFor: (workspaceId) =>
            createQuota(
                host.db,
                providers,
                manifest,
                async () => (await host.db.workspaces.findById(workspaceId))?.owner_user_id ?? null,
                host.logger
            ),
        pauses: modulePauses(manifest),
        accounts: {
            find: async (userId) => {
                gateAccounts();
                const row = await host.db.users.findById(userId);
                return row ? toSdkAccount(row) : null;
            },
            findByEmail: async (email) => {
                gateAccounts();
                const row = await host.db.users.findByEmail(email.trim().toLowerCase());
                return row ? toSdkAccount(row) : null;
            },
            list: async (userIds) => {
                gateAccounts();
                return (await host.db.users.findByIds([...userIds])).map(toSdkAccount);
            },
            search: async (query, limit) => {
                gateAccounts();
                const capped = Math.min(Math.max(1, Math.trunc(limit ?? 20)), 50);
                return (await host.db.users.search(query.trim(), capped)).map(toSdkAccount);
            }
        },
        audit: (entry) => {
            host.audit.record({
                action: entry.action,
                description: entry.description,
                level: entry.level ?? 'info',
                category: AUDIT_CATEGORY[manifest.id] ?? manifest.id,
                source: 'system',
                // 0 = le système, la convention d'AuditEvent.
                uid: entry.userId ?? 0,
                ip: '',
                metadata: entry.metadata ?? null
            });
        },
        agents: agentsFacade(gateAgents),
        keys,
        providers,
        createTicker: ({ intervalMs, tick }): FeatureService => {
            // setInterval + garde de réentrance + unref ; stop() attend le tour en vol,
            // pour qu'un start() rapproché ne croise pas ses restes.
            let timer: ReturnType<typeof setInterval> | null = null;
            let ticking: Promise<void> | null = null;
            const run = async (): Promise<void> => {
                try {
                    await tick();
                } catch (e) {
                    host.logger.error({ feature: manifest.id, err: (e as Error).message }, 'Module tick failed');
                }
            };
            return {
                start: () => {
                    if (timer) return;
                    timer = setInterval(() => {
                        if (ticking) return;
                        ticking = run().finally(() => {
                            ticking = null;
                        });
                    }, intervalMs);
                    timer.unref();
                },
                stop: async () => {
                    if (timer) clearInterval(timer);
                    timer = null;
                    await ticking;
                }
            };
        },
        logger: host.logger
    };
}
