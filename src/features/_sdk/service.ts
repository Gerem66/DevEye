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
import { serverKeysOf } from './host';
import { ORIGINS } from './context';
import { createOpenCipher, createSecureStore } from '@/Services/SecureStore';
import { verifyModuleTicket } from '@/auth/jwt';
import type { Logger } from 'pino';
import type { AuditLog } from '@/Services/AuditLog';
import type { LiveHub } from '@/live/hub';
import { agentsFacade, createFacade, createTelemetry, toSdkDevice } from './facade';
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
    /**
     * Présence en direct : un service écrit sans commande utilisateur, donc
     * sans socket pour diffuser, et c'est le hub qu'il avertit directement.
     */
    live: LiveHub;
}

/**
 * L'alias de catégorie d'audit : la continuité des lignes persistées prime
 * sur la convention (les audits CloudSync ont toujours porté `cloudSync`,
 * l'id de la feature est `cloudsync`). Table courte, côté app exprès : le SDK
 * n'expose pas la catégorie.
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
        // Même mémoïsation par espace que les services de fond : la résolution de la
        // clé ouverte coûte une lecture, pas plus, mais un tick n'a pas à la
        // repayer à chaque ligne.
        const cipher = createOpenCipher(host.db, host.crypt, workspaceId);
        ciphers.set(workspaceId, cipher);
        return cipher;
    };

    // La façade sessionless d'un espace : notify et devices, gardés par les
    // capacités du manifest comme dans une requête. Sans session, le
    // propriétaire n'entre pas en jeu (members n'est pas exposé ici).
    const facades = new Map<number, DevEyeFacade>();
    const facadeFor = (workspaceId: number): DevEyeFacade => {
        const hit = facades.get(workspaceId);
        if (hit) return hit;
        const facade = createFacade({
            db: host.db,
            cipher: cipherFor(workspaceId),
            workspaceId,
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

    // La même faute, la même erreur qu'en requête (`facade.ts`) : typée, et
    // nommant la capacité manquante.
    const capabilities = new Set(manifest.nativeCapabilities ?? []);
    const gate = (cap: 'agents' | 'devices.read' | 'telemetry.read') => (): void => {
        if (!capabilities.has(cap)) {
            throw new FeatureError('forbidden', `Module « ${manifest.id} » : declare '${cap}' in nativeCapabilities`);
        }
    };
    const gateAgents = gate('agents');
    const gateDevices = gate('devices.read');
    const keys = serverKeysOf(host.crypt);

    return {
        repo,
        listWorkspaceIds: async () => {
            const r = await host.db.queryable.query<{ id: number }>('SELECT id FROM workspaces ORDER BY id');
            return r.rows.map((row) => row.id);
        },
        // La variante sessionless du store : le type du SDK interdit déjà
        // d'écrire en 'private', et le store lève `locked` si un tick tente
        // d'en LIRE une (guarded: null).
        storeFor: (workspaceId) =>
            createFeatureStore(host.db.featureKv, manifest.id, workspaceId, {
                open: cipherFor(workspaceId),
                guarded: null
            }),
        cipherFor,
        // Le ticket d'un module, rendu contre les codecs de son porteur : la
        // session est relue par l'hôte (jamais transmise au module), et l'étage
        // gardé n'est tendu que si elle est encore déverrouillée.
        secrecy: {
            redeem: async (ticket) => {
                const claims = await verifyModuleTicket(manifest.id, ticket);
                if (!claims) return null;
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
        deveyeFor: (workspaceId) => ({ notify: facadeFor(workspaceId).notify }),
        devicesFor: (workspaceId) => {
            const { list, isOnline } = facadeFor(workspaceId).devices;
            return { list, isOnline };
        },
        // La flotte entière, par identifiant : ce qu'un moteur qui reçoit les
        // trames de tous les appareils a besoin de relire, sans espace.
        devices: {
            find: async (deviceId) => {
                gateDevices();
                const row = await host.db.devices.findById(deviceId);
                return row ? toSdkDevice(row) : null;
            },
            isOnline: (deviceId) => (gateDevices(), sdkHub().isOnline(deviceId))
        },
        telemetry: createTelemetry(host.db, gate('telemetry.read')),
        // Le sujet d'un module EST son id (contrat du manifest, validé à
        // l'enregistrement) ; la diffusion traverse les projections d'une
        // feature branchée au partage, le hub s'en charge.
        live: {
            // Le sujet du module, ou ceux que le service nomme (les siens, un
            // secondaire, celui d'une autre feature) : la même règle que
            // `mutates` d'un handler, sans le filet du boot (un sujet inconnu
            // n'a simplement aucun abonné).
            changed: (workspaceId, topics) =>
                host.live.changed(workspaceId, (topics ?? [manifest.id]) as LiveTopic[], null)
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
            // Le patron des sept services natifs : setInterval + garde de
            // réentrance + unref, et rien d'autre. Pas de cron, pas de file.
            let timer: ReturnType<typeof setInterval> | null = null;
            let ticking = false;
            const run = async (): Promise<void> => {
                if (ticking) return;
                ticking = true;
                try {
                    await tick();
                } catch (e) {
                    host.logger.error({ feature: manifest.id, err: (e as Error).message }, 'Module tick failed');
                } finally {
                    ticking = false;
                }
            };
            return {
                start: () => {
                    if (timer) return;
                    timer = setInterval(() => void run(), intervalMs);
                    timer.unref();
                },
                stop: () => {
                    if (timer) clearInterval(timer);
                    timer = null;
                }
            };
        },
        logger: host.logger
    };
}
