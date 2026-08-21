import type { AgentsFacade, DevEyeFacade, SdkCipher, SdkDevice } from 'deveye-types/sdk/server';
import { FeatureError } from 'deveye-types/sdk/server';
import type { FeatureManifest, NativeCapability } from 'deveye-types/sdk';
import type { NotificationFeature } from 'deveye-types';

import type { Database } from '@/db';
import type { Logger } from 'pino';
import { deliver, hasChannel, resolveRoute } from '@/Services/notifications';
import { sdkHub } from './host';

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
    manifest: FeatureManifest;
    logger: Logger;
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
                const channels = await resolveRoute(deps.db, cipher, deps.workspaceId, feature, opts?.itemId);
                if (!hasChannel(channels)) return false;
                return deliver(
                    channels,
                    {
                        subject: alert.subject,
                        body: alert.body,
                        payload: alert.payload ?? { feature: deps.manifest.id }
                    },
                    deps.logger
                );
            }
        },
        mail: {
            async listAccounts() {
                gate('mail.accounts');
                const rows = await deps.db.mailAccounts.listByWorkspace(deps.workspaceId);
                // Palier « open » seulement : un compte gardé n'est pas lisible
                // sans session, et un module n'a pas à savoir qu'il existe.
                const open = rows.filter((r) => r.security_tier === 'open');
                return Promise.all(
                    open.map(async (r) => ({
                        id: r.id,
                        label: (await deps.cipher.tryDecrypt(r.display_name_enc)) ?? `Compte ${r.id}`,
                        address: await deps.cipher.tryDecrypt(r.email_address_enc)
                    }))
                );
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
                    isOwner: u.id === deps.ownerUserId
                }));
            }
        },
        devices: {
            // Sémantique d'`authorizeDevice` (features/devices/shared) : la
            // ligne doit exister ET appartenir à CET espace, l'admin global
            // passant outre l'appartenance.
            async authorize(deviceId) {
                gate('devices.read');
                const row = await deps.db.devices.findById(deviceId);
                if (!row) throw new FeatureError('not_found', 'Appareil introuvable');
                if (!deps.isAdmin && !(await deps.db.devices.hasWorkspace(row.id, deps.workspaceId))) {
                    throw new FeatureError('forbidden', 'Cet appareil ne relève pas de cet espace');
                }
                return toSdkDevice(row.id, row.name);
            },
            async list() {
                gate('devices.read');
                const rows = await deps.db.devices.listByWorkspace(deps.workspaceId);
                return rows.map((r) => toSdkDevice(r.id, r.name));
            },
            isOnline(deviceId) {
                gate('devices.read');
                return sdkHub().isOnline(deviceId);
            }
        },
        agents: agentsFacade(() => gate('agents'))
    };
}

function toSdkDevice(id: string, name: string): SdkDevice {
    return { id, name, online: sdkHub().isOnline(id) };
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
        publishSyncState: (payload) => (gate(), sdkHub().publishSyncState(payload))
    };
}
