import type {
    DevEyeFacade,
    FeatureService,
    FeatureServiceDeps,
    SdkCipher,
    SdkServerKeys
} from '@deveye/types/sdk/server';
import type { FeatureManifest } from '@deveye/types/sdk';

import type { Database } from '@/db';
import type Encryption from '@/Services/Encryption';
import { FeatureError } from '@deveye/types/sdk/server';
import { createOpenCipher } from '@/Services/SecureStore';
import type { Logger } from 'pino';
import type { AuditLog } from '@/Services/AuditLog';
import { agentsFacade, createFacade } from './facade';
import { createFeatureStore } from './store';

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
    repo: unknown
): FeatureServiceDeps {
    const ciphers = new Map<number, SdkCipher>();
    const cipherFor = (workspaceId: number): SdkCipher => {
        const hit = ciphers.get(workspaceId);
        if (hit) return hit;
        // Même mémoïsation par espace que BackupService : la résolution de la
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
            manifest,
            logger: host.logger
        });
        facades.set(workspaceId, facade);
        return facade;
    };

    // La même faute, la même erreur qu'en requête (`facade.ts`) : typée, et
    // nommant la capacité manquante.
    const capabilities = new Set(manifest.nativeCapabilities ?? []);
    const gateAgents = (): void => {
        if (!capabilities.has('agents')) {
            throw new FeatureError('forbidden', `Module « ${manifest.id} » : declare 'agents' in nativeCapabilities`);
        }
    };
    const keys: SdkServerKeys = {
        sealBytes: (plain) => host.crypt.seal(Buffer.from(plain)),
        openBytes: (sealed) => host.crypt.openRaw(sealed)
    };

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
        deveyeFor: (workspaceId) => ({ notify: facadeFor(workspaceId).notify }),
        devicesFor: (workspaceId) => {
            const { list, isOnline } = facadeFor(workspaceId).devices;
            return { list, isOnline };
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
