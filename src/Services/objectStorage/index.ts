import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { SdkLogger, SdkObjectStore } from '@deveye/types/sdk/server';
import { fetch as undiciFetch } from 'undici';

import { env } from '@/Utils/Env';

import { assertObjectKey, SPOOL_DIR } from './keys';
import { localObjectStore } from './local';
import { S3Client, type S3Fetch } from './s3';

/**
 * Le transport du bucket de l'hôte : l'adresse vient de l'opérateur, qui peut
 * viser son propre réseau (un MinIO du réseau Docker). Pas de redirection :
 * un bucket qui renvoie ailleurs est mal configuré, on le dit.
 */
const trustedFetch: S3Fetch = (url, init) => undiciFetch(url, { ...init, redirect: 'manual' });

let client: S3Client | null = null;
function s3Client(): S3Client | null {
    if (!env.STORAGE_S3_ENDPOINT) return null;
    client ??= new S3Client(
        {
            endpoint: env.STORAGE_S3_ENDPOINT,
            region: env.STORAGE_S3_REGION as string,
            bucket: env.STORAGE_S3_BUCKET as string,
            accessKeyId: env.STORAGE_S3_ACCESS_KEY_ID as string,
            secretAccessKey: env.STORAGE_S3_SECRET_ACCESS_KEY as string,
            pathStyle: env.STORAGE_S3_PATH_STYLE
        },
        trustedFetch
    );
    return client;
}

/** Le préfixe de l'instance dans le bucket, `/` final compris, ou `''`. */
function instancePrefix(): string {
    const raw = (env.STORAGE_S3_PREFIX ?? '').replace(/^\/+|\/+$/g, '');
    return raw ? `${raw}/` : '';
}

/** Le magasin d'un module dans le bucket : toutes ses clés sous `<préfixe>/<module>/`. */
function s3ObjectStore(s3: S3Client, featureId: string, spool: string): SdkObjectStore {
    const base = `${instancePrefix()}${featureId}/`;
    const full = (key: string): string => {
        assertObjectKey(key);
        return base + key;
    };
    return {
        kind: 's3',
        describe: () => `S3 : ${env.STORAGE_S3_BUCKET}`,
        async put(key, body) {
            const size = await s3.putStream(full(key), body instanceof Uint8Array ? [body] : body);
            return { size };
        },
        async putFile(key, localPath) {
            const size = await s3.putStream(full(key), createReadStream(localPath));
            await fs.rm(localPath, { force: true });
            return { size };
        },
        get: (key, range) => s3.getObject(full(key), range),
        head: (key) => s3.headObject(full(key)),
        async *list(prefix) {
            for await (const object of s3.listObjects(base + prefix)) {
                yield { key: object.key.slice(base.length), size: object.size };
            }
        },
        delete: (key) => s3.deleteObject(full(key)),
        async deletePrefix(prefix) {
            if (!prefix.endsWith('/')) throw new Error(`Préfixe sans « / » final : « ${prefix} »`);
            assertObjectKey(prefix.slice(0, -1));
            await s3.deletePrefix(base + prefix);
        },
        spoolDir: () => spool
    };
}

const stores = new Map<string, SdkObjectStore>();

/**
 * Le magasin d'un module (`deps.objects`). `localDir` est son dossier : la
 * racine des objets sur disque, et seulement celle du spool quand un bucket
 * est configuré.
 */
export function objectStoreFor(featureId: string, localDir: string): SdkObjectStore {
    const id = `${featureId}\0${path.resolve(localDir)}`;
    const hit = stores.get(id);
    if (hit) return hit;
    const s3 = s3Client();
    const store = s3
        ? s3ObjectStore(s3, featureId, path.join(path.resolve(localDir), SPOOL_DIR))
        : localObjectStore(localDir);
    stores.set(id, store);
    return store;
}

/**
 * Au démarrage : dit où vont les fichiers, et vérifie qu'un bucket configuré
 * répond, par un aller-retour sur un objet témoin. Un échec n'arrête pas le
 * serveur (le bucket peut revenir), il se lit dans le journal.
 */
export async function announceObjectStorage(logger: SdkLogger): Promise<void> {
    const s3 = s3Client();
    if (!s3) {
        logger.info('Stockage des fichiers : disque du serveur (STORAGE_S3_ENDPOINT vide)');
        return;
    }
    const key = `${instancePrefix()}.probe/${crypto.randomBytes(8).toString('hex')}`;
    try {
        const witness = Buffer.from('deveye');
        await s3.putStream(key, [witness]);
        let read = 0;
        for await (const chunk of s3.getObject(key)) read += chunk.length;
        await s3.deleteObject(key);
        if (read !== witness.length) throw new Error('objet témoin relu tronqué');
        logger.info({ bucket: env.STORAGE_S3_BUCKET, prefix: instancePrefix() }, 'Stockage des fichiers : S3');
    } catch (e) {
        logger.error(
            { err: e, endpoint: env.STORAGE_S3_ENDPOINT, bucket: env.STORAGE_S3_BUCKET },
            'Stockage des fichiers : le bucket S3 ne répond pas, les envois de fichiers échoueront'
        );
    }
}
