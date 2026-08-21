import type { ZodType } from 'zod';
import type { FeatureStore, SdkCipher, StorageEncryption } from 'deveye-types/sdk/server';
import { FeatureError } from 'deveye-types/sdk/server';

import type { FeatureKvRepo } from '@/db/repos/featureKv';

/**
 * Le FeatureStore du SDK : `feature_kv` (migration 095) + le bon cipher.
 *
 * Le mode est figé sur la ligne à l'écriture ; la lecture le relit et choisit
 * le déchiffrement en conséquence. `guarded: null` est la variante sessionless
 * des services d'arrière-plan : écrire en 'private' y est déjà inexprimable
 * (type du SDK), et LIRE une ligne 'private' y lève `locked`, fort, plutôt que
 * de rendre un blob illisible.
 */
export function createFeatureStore(
    kv: FeatureKvRepo,
    feature: string,
    workspaceId: number,
    ciphers: { open: SdkCipher; guarded: SdkCipher | null }
): FeatureStore {
    const cipherFor = (mode: StorageEncryption): SdkCipher | null => {
        if (mode === 'none') return null;
        if (mode === 'server') return ciphers.open;
        if (ciphers.guarded === null) {
            throw new FeatureError('locked', 'Donnée privée : illisible hors session déverrouillée');
        }
        return ciphers.guarded;
    };

    const write = async (key: string, raw: string, mode: StorageEncryption): Promise<void> => {
        const cipher = cipherFor(mode);
        const value = cipher ? await cipher.encrypt(raw) : raw;
        await kv.put(workspaceId, feature, key, mode, value);
    };

    const read = async (key: string): Promise<string | null> => {
        const row = await kv.get(workspaceId, feature, key);
        if (!row) return null;
        const cipher = cipherFor(row.mode);
        return cipher ? cipher.decrypt(row.value) : row.value;
    };

    return {
        put: (key, value, opts) => write(key, value, opts?.encryption ?? 'server'),
        putJson: <T>(key: string, schema: ZodType<T>, value: T, opts?: { encryption?: StorageEncryption }) =>
            write(key, JSON.stringify(schema.parse(value)), opts?.encryption ?? 'server'),
        get: read,
        getJson: async <T>(key: string, schema: ZodType<T>): Promise<T | null> => {
            const raw = await read(key);
            return raw === null ? null : schema.parse(JSON.parse(raw));
        },
        remove: (key) => kv.remove(workspaceId, feature, key),
        keys: (prefix) => kv.keys(workspaceId, feature, prefix ?? '')
    };
}
