import crypto from 'crypto';
import type { Database } from '../db';
import Encryption from '../Services/Encryption';

/**
 * Chiffrement au repos du blob store CloudSync.
 *
 * ⚠️ Exception assumée au modèle zero-knowledge (Docs/SECURITY_MODEL.md) : les
 * contenus synchronisés sont chiffrés par une clé détenue par le serveur — pas
 * par la DEK utilisateur wrappée par mot de passe — parce que la synchro doit
 * tourner en tâche de fond, session verrouillée ou pas, et que des fichiers de
 * plusieurs Go ne passent pas par MySQL. Protège le disque au repos, pas
 * contre une compromission du serveur vivant.
 *
 * Clé : une BMK (Blob Master Key, 32 octets aléatoires) générée au premier
 * boot, wrappée par la clé serveur (`Encryption.encryptWithKey`, même schéma
 * que le wrap des DEK dans SecretKeyService) et rangée dans `sync_meta`.
 * Faire tourner CRYPT_KEY_A/B ne demande que de re-wrapper 32 octets, jamais
 * de re-chiffrer les blobs.
 *
 * Le FORMAT de conteneur (`DEVB` v1/v2), lui, vit dans `@/backup/devb` : les
 * archives Backup l'emploient aussi (autre clé), et une seule définition vaut
 * mieux que deux qui divergent. Ce fichier ne garde que la clé.
 */

export {
    BLOB_CHUNK_BYTES,
    BLOB_CHUNK_SEALED,
    BLOB_HEADER_LEN,
    BLOB_TAG_LEN,
    BLOB_VERSION_CHUNKED,
    BLOB_VERSION_STREAM,
    createBlobHeader,
    openChunk,
    openStreamDecipher,
    parseBlobHeader,
    sealChunk
} from '../backup/devb';

const BLOB_KEY_META = 'blob_key_wrapped';

/** Charge la BMK, en la créant (et wrappant) au premier appel. */
export async function ensureBlobKey(db: Database, crypt: Encryption): Promise<Buffer> {
    const wrapped = await db.syncMeta.get(BLOB_KEY_META);
    if (wrapped !== null) {
        const bmk = Encryption.decryptWithKeyRaw(crypt.serverKey(), wrapped);
        if (bmk === null || bmk.length !== 32) {
            throw new Error('CloudSync : impossible de dé-wrapper la clé des blobs (CRYPT_KEY_A/B ont changé ?)');
        }
        return bmk;
    }
    const bmk = crypto.randomBytes(32);
    await db.syncMeta.set(BLOB_KEY_META, Encryption.encryptWithKey(crypt.serverKey(), bmk));
    return bmk;
}
