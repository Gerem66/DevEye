import type { FeatureManifest } from '@deveye/types/sdk';
import {
    FeatureError,
    normaliseDomainHost,
    type FeatureDomainsContext,
    type SdkCipher,
    type SdkDomain,
    type SdkDomains,
    type SdkFleetDomains
} from '@deveye/types/sdk/server';
import type { Logger } from 'pino';

import type { Database } from '@/db';
import type { FeatureDomainRow } from '@/db/repos/featureDomains';
import { systemDns } from '@/Services/domains/dns';
import type Encryption from '@/Services/Encryption';
import { createOpenCipher } from '@/Services/SecureStore';
import { ORIGINS } from './context';
import { serverKeysOf } from './host';
import { createFeatureStore } from './store';

/** Ce qu'il faut de l'hôte pour parler des domaines : une requête comme un service l'ont. */
export interface DomainsHost {
    db: Database;
    crypt: Encryption;
    logger: Logger;
}

export function toSdkDomain(row: FeatureDomainRow): SdkDomain {
    return {
        id: row.id,
        workspaceId: row.workspace_id,
        host: row.host,
        token: row.token,
        verified: row.verified_at !== null,
        verifiedAt: row.verified_at
    };
}

/** La même erreur de contrat que `sharing.scope` sous `shareTier: 'never'`. */
function assertDeclared(manifest: FeatureManifest): void {
    if (!manifest.domains) {
        throw new FeatureError('forbidden', `Module « ${manifest.id} » : declare domains in the manifest`);
    }
}

export function sdkDomains(db: Database, manifest: FeatureManifest, workspaceId: number): SdkDomains {
    const list = async (): Promise<SdkDomain[]> => {
        assertDeclared(manifest);
        return (await db.featureDomains.list(workspaceId, manifest.id)).map(toSdkDomain);
    };
    return {
        list,
        get: async (id) => {
            assertDeclared(manifest);
            const row = await db.featureDomains.find(id, workspaceId, manifest.id);
            return row ? toSdkDomain(row) : null;
        },
        verified: async () => (await list()).filter((domain) => domain.verified)
    };
}

export function sdkFleetDomains(db: Database, manifest: FeatureManifest): SdkFleetDomains {
    return {
        findByHost: async (host) => {
            assertDeclared(manifest);
            const row = await db.featureDomains.findByHost(manifest.id, normaliseDomainHost(host));
            return row ? toSdkDomain(row) : null;
        },
        get: async (workspaceId, id) => {
            assertDeclared(manifest);
            const row = await db.featureDomains.find(id, workspaceId, manifest.id);
            return row ? toSdkDomain(row) : null;
        },
        listVerified: async (workspaceId) => {
            assertDeclared(manifest);
            return (await db.featureDomains.list(workspaceId, manifest.id))
                .filter((row) => row.verified_at !== null)
                .map(toSdkDomain);
        }
    };
}

/** Le contexte des crochets `domains` d'un module : sans session, étage ouvert seulement. */
export function createDomainsContext(
    host: DomainsHost,
    manifest: FeatureManifest,
    repo: unknown
): FeatureDomainsContext {
    const ciphers = new Map<number, SdkCipher>();
    const cipherFor = (workspaceId: number): SdkCipher => {
        let cipher = ciphers.get(workspaceId);
        if (!cipher) {
            cipher = createOpenCipher(host.db, host.crypt, workspaceId);
            ciphers.set(workspaceId, cipher);
        }
        return cipher;
    };
    return {
        repo,
        origins: ORIGINS,
        cipherFor,
        storeFor: (workspaceId) =>
            createFeatureStore(host.db.featureKv, manifest.id, workspaceId, {
                open: cipherFor(workspaceId),
                guarded: null
            }),
        keys: serverKeysOf(host.crypt, manifest.id),
        dns: systemDns,
        logger: host.logger
    };
}
