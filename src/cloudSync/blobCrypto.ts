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
 * Format disque d'un blob :
 *   magic 'DEVB' (4) | version 0x01 (1) | nonce (12) | ciphertext | tag GCM (16)
 * AES-256-GCM en flux ; nonce aléatoire par blob.
 */

const BLOB_KEY_META = 'blob_key_wrapped';
const BLOB_MAGIC = Buffer.from('DEVB');
const BLOB_VERSION = 0x01;

/** Longueur de l'en-tête (magic + version + nonce) et du tag final. */
export const BLOB_HEADER_LEN = BLOB_MAGIC.length + 1 + 12;
export const BLOB_TAG_LEN = 16;

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

/** Démarre le chiffrement d'un blob : l'appelant écrit `header` puis les sorties du cipher. */
export function createBlobCipher(bmk: Buffer): { header: Buffer; cipher: crypto.CipherGCM } {
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', bmk, nonce);
    const header = Buffer.concat([BLOB_MAGIC, Buffer.from([BLOB_VERSION]), nonce]);
    return { header, cipher };
}

/** Ouvre le déchiffrement d'un blob depuis son en-tête (lève si format inconnu). */
export function openBlobDecipher(bmk: Buffer, header: Buffer): crypto.DecipherGCM {
    if (header.length !== BLOB_HEADER_LEN || !header.subarray(0, 4).equals(BLOB_MAGIC)) {
        throw new Error('CloudSync : blob corrompu (en-tête invalide)');
    }
    if (header[4] !== BLOB_VERSION) {
        throw new Error(`CloudSync : version de blob inconnue (${header[4]})`);
    }
    const nonce = header.subarray(5, 17);
    return crypto.createDecipheriv('aes-256-gcm', bmk, nonce);
}
