import type { ZodType } from 'zod';
import { ZodError } from 'zod';
import type { FeatureStore, SdkCipher, StorageEncryption } from '@deveye/types/sdk/server';
import { FeatureError } from '@deveye/types/sdk/server';

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

    // Une valeur hors schéma à l'écriture est une faute de l'appelant ; à la
    // lecture, c'est une ligne que le schéma ne décrit plus : deux erreurs
    // typées, jamais un ZodError brut que le dispatcheur rendrait opaque.
    const parseOr = <T>(schema: ZodType<T>, value: unknown, code: 'validation' | 'internal', key: string): T => {
        try {
            return schema.parse(value);
        } catch (e) {
            if (e instanceof ZodError)
                throw new FeatureError(code, `store « ${key} » : ${e.issues[0]?.message ?? 'hors schéma'}`);
            throw e;
        }
    };

    return {
        put: (key, value, opts) => write(key, value, opts?.encryption ?? 'server'),
        // `async` pour qu'une valeur hors schéma REJETTE la promesse promise par
        // le contrat, au lieu de lever avant même de la rendre.
        putJson: async <T>(key: string, schema: ZodType<T>, value: T, opts?: { encryption?: StorageEncryption }) =>
            write(key, JSON.stringify(parseOr(schema, value, 'validation', key)), opts?.encryption ?? 'server'),
        get: read,
        getJson: async <T>(key: string, schema: ZodType<T>): Promise<T | null> => {
            const raw = await read(key);
            return raw === null ? null : parseOr(schema, JSON.parse(raw), 'internal', key);
        },
        remove: (key) => kv.remove(workspaceId, feature, key),
        keys: (prefix) => kv.keys(workspaceId, feature, prefix ?? '')
    };
}
