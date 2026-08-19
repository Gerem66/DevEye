import crypto from 'crypto';

import {
    BLOB_CHUNK_BYTES,
    BLOB_CHUNK_SEALED,
    BLOB_HEADER_LEN,
    BLOB_VERSION_CHUNKED,
    createBlobHeader,
    openChunk,
    parseBlobHeader,
    sealChunk
} from '@/cloudSync/blobCrypto';
import type Encryption from '@/Services/Encryption';

/**
 * Chiffrement des archives de sauvegarde.
 *
 * ## Le format est celui de CloudSync, délibérément
 *
 * `DEVB` v2 : en-tête (magic + version + nonce de base), puis des blocs de
 * 1 Mio scellés en AES-256-GCM, nonce dérivé du compteur, AAD portant le rang et
 * le marqueur de fin. Réécrire un second format aurait produit un second
 * outil de restauration à tenir à jour, et c'est exactement le genre de dette
 * qu'on découvre le jour où on doit s'en servir. Voir `cloudSync/blobCrypto.ts`
 * pour la description complète du format et la raison de chacun de ses champs.
 *
 * ## La clé, en revanche, n'est PAS celle de CloudSync
 *
 * La BMK de CloudSync est tirée au premier démarrage puis rangée, *wrappée*,
 * dans la table `sync_meta`. Ce serait un piège mortel ici : la sauvegarde de la
 * base contient `sync_meta`, donc la clé qui déchiffre l'archive dormirait à
 * l'intérieur de l'archive. Le jour où on la restaure — c'est-à-dire le jour où
 * la base a disparu — on n'aurait aucun moyen de l'ouvrir.
 *
 * La clé de sauvegarde est donc **dérivée**, jamais stockée :
 *
 *     BAK = HKDF-SHA256(serverKey, salt = 'deveye-backup', info = 'v1', 32)
 *
 * `serverKey` est lui-même un condensé de `CRYPT_KEY_A`/`CRYPT_KEY_B`, qui
 * vivent dans l'environnement. Deux conséquences, l'une heureuse et l'autre à
 * garder en tête :
 *
 *  - restaurer ne demande que les deux variables d'environnement et
 *    `scripts/restore-backup.mjs`. Aucune base, aucun DevEye vivant ;
 *  - **`CRYPT_KEY_A`/`CRYPT_KEY_B` sont la sauvegarde.** Les perdre transforme
 *    toutes les archives scellées en bruit. Elles se rangent là où on range une
 *    clé, pas à côté des archives.
 */

const BACKUP_KEY_SALT = Buffer.from('deveye-backup');
const BACKUP_KEY_INFO = Buffer.from('v1');

/** La clé de scellement des archives. Purement dérivée : rien à stocker. */
export function backupKey(crypt: Encryption): Buffer {
    return Buffer.from(crypto.hkdfSync('sha256', crypt.serverKey(), BACKUP_KEY_SALT, BACKUP_KEY_INFO, 32));
}

/**
 * Scelle un flux de clair en flux `DEVB` v2.
 *
 * Le découpage d'entrée n'a aucune importance : on ré-agrège nous-mêmes en blocs
 * de {@link BLOB_CHUNK_BYTES}, parce qu'un bloc de taille variable rendrait la
 * relecture impossible — l'ouvreur compte les blocs pour retrouver leur rang.
 */
export async function* sealStream(key: Buffer, source: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
    const header = createBlobHeader();
    const nonce = header.subarray(5, 17);
    yield header;

    let pending: Buffer[] = [];
    let pendingLen = 0;
    let index = 0;

    for await (const part of source) {
        pending.push(part);
        pendingLen += part.length;
        while (pendingLen >= BLOB_CHUNK_BYTES) {
            const joined = Buffer.concat(pending, pendingLen);
            yield sealChunk(key, nonce, index, joined.subarray(0, BLOB_CHUNK_BYTES), false);
            index += 1;
            const rest = joined.subarray(BLOB_CHUNK_BYTES);
            pending = rest.length > 0 ? [rest] : [];
            pendingLen = rest.length;
        }
    }

    // Toujours un dernier bloc, même vide : c'est lui qui porte le marqueur de
    // fin dans l'AAD, et donc ce qui rend une archive tronquée détectable.
    yield sealChunk(key, nonce, index, Buffer.concat(pending, pendingLen), true);
}

/**
 * Ouvre un flux `DEVB` v2 et rend le clair.
 *
 * Lève dès qu'un bloc ne s'authentifie pas — contenu modifié, blocs
 * réordonnés, ou archive coupée avant sa fin. Une sauvegarde qu'on ne peut pas
 * prouver intacte n'en est pas une, donc jamais de lecture tolérante ici.
 */
export async function* openSealedStream(key: Buffer, source: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
    let buffer: Buffer = Buffer.alloc(0);
    let nonce: Buffer | null = null;
    let index = 0;

    const take = (n: number): Buffer | null => {
        if (buffer.length < n) return null;
        const out = buffer.subarray(0, n);
        buffer = buffer.subarray(n);
        return out;
    };

    for await (const part of source) {
        buffer = buffer.length === 0 ? part : Buffer.concat([buffer, part]);

        if (nonce === null) {
            const header = take(BLOB_HEADER_LEN);
            if (header === null) continue;
            const parsed = parseBlobHeader(header);
            if (parsed.version !== BLOB_VERSION_CHUNKED) {
                throw new Error('Archive de sauvegarde : format de bloc inattendu.');
            }
            nonce = parsed.nonce;
        }

        // On garde toujours de quoi former un dernier bloc : tant qu'il reste
        // exactement `BLOB_CHUNK_SEALED` octets, on ne peut pas savoir s'ils
        // sont un bloc intermédiaire ou le bloc final — et l'AAD diffère.
        while (buffer.length > BLOB_CHUNK_SEALED) {
            const sealed = take(BLOB_CHUNK_SEALED);
            if (sealed === null) break;
            yield openChunk(key, nonce, index, sealed, false);
            index += 1;
        }
    }

    if (nonce === null) throw new Error('Archive de sauvegarde : en-tête absent ou tronqué.');
    yield openChunk(key, nonce, index, buffer, true);
}
