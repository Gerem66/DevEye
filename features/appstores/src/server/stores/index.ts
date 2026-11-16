import type { AppStore, AppStoresCapability } from '../../contracts/domain';
import { FeatureError, type SdkCipher } from '@deveye/types/sdk/server';

import type { SourceRow } from '../repo';
import type { StoredSource } from '../_shared';
import { appleClient, probeApple, type AppleClient, type AppleCredentials } from './apple';
import { googleClient, probeGoogle, type GoogleClient, type GoogleCredentials } from './google';
import { StoreError } from './types';

/** Les clés d'une source, ouvertes : ce que les clients des stores prennent. */
export type StoreCredentials =
    { store: 'apple'; creds: AppleCredentials } | { store: 'google'; creds: GoogleCredentials };

/** Ce que le service appelle chez les stores ; un test en passe un double. */
export interface StoreClients {
    apple: AppleClient;
    google: GoogleClient;
}

export const STORE_CLIENTS: StoreClients = { apple: appleClient, google: googleClient };

/** Les clés d'une source à partir de ce qu'elle porte ; `null` quand il manque une pièce. */
export function credentialsOf(store: AppStore, content: StoredSource, secret: string): StoreCredentials | null {
    if (store === 'apple') {
        if (!content.issuerId || !content.keyId || !content.vendorNumber) return null;
        return {
            store,
            creds: {
                issuerId: content.issuerId,
                keyId: content.keyId,
                vendorNumber: content.vendorNumber,
                privateKey: secret
            }
        };
    }
    if (!content.clientEmail || !content.bucket) return null;
    return {
        store,
        creds: {
            clientEmail: content.clientEmail,
            privateKey: secret,
            privateKeyId: content.privateKeyId ?? null,
            bucket: content.bucket
        }
    };
}

/** Les clés d'une source enregistrée, déchiffrées à l'étage ouvert ; `null` si elles ne se lisent plus. */
export async function openCredentials(
    cipher: SdkCipher,
    row: Pick<SourceRow, 'store' | 'content' | 'secret_enc'>
): Promise<{ content: StoredSource; credentials: StoreCredentials } | null> {
    const plain = await cipher.tryDecrypt(row.content);
    const secret = await cipher.tryDecrypt(row.secret_enc);
    if (plain === null || !secret) return null;
    let content: StoredSource;
    try {
        content = JSON.parse(plain) as StoredSource;
    } catch {
        return null;
    }
    const credentials = credentialsOf(row.store, content, secret);
    return credentials ? { content, credentials } : null;
}

export function probeStore(credentials: StoreCredentials, signal?: AbortSignal): Promise<AppStoresCapability[]> {
    return credentials.store === 'apple'
        ? probeApple(credentials.creds, signal)
        : probeGoogle(credentials.creds, signal);
}

const KEY_REFUSED: Record<AppStore, string> = {
    apple: 'Apple refuse cette clé : vérifiez l’Issuer ID et le Key ID, et que la clé n’a pas été révoquée dans App Store Connect.',
    google: 'Google refuse ce compte de service : sa clé a pu être supprimée, ou le compte désactivé dans Google Cloud.'
};

const UNREACHABLE: Record<AppStore, string> = {
    apple: 'Apple ne répond pas : réessayez dans un instant.',
    google: 'Google ne répond pas : réessayez dans un instant.'
};

/**
 * Un échec de store pendant une commande, dit en clair. La clé refusée lève
 * `refusedAs` : `validation` quand on vient de la saisir, `conflict` ailleurs.
 * Rien de cela n'est une panne de l'instance, jamais `internal`.
 */
export function storeFailure(e: unknown, refusedAs: 'validation' | 'conflict'): never {
    if (!(e instanceof StoreError)) throw e;
    if (e.status === 401) throw new FeatureError(refusedAs, KEY_REFUSED[e.store]);
    if (e.status === 0 || e.status >= 500) throw new FeatureError('conflict', UNREACHABLE[e.store]);
    throw new FeatureError('conflict', e.message);
}
