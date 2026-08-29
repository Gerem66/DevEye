import {
    BLOB_CHUNK_BYTES,
    BLOB_CHUNK_SEALED,
    BLOB_HEADER_LEN,
    BLOB_VERSION_CHUNKED,
    createBlobHeader,
    openChunk,
    parseBlobHeader,
    sealChunk,
    type SdkServerKeys
} from '@deveye/types/sdk/server';

/**
 * Scellement des archives au format `DEVB` v2 de CloudSync
 * (`@deveye/types/sdk/server`, `devb.ts`) : un seul outil de restauration.
 *
 * La clé n'est PAS la BMK de CloudSync, rangée dans `sync_meta` donc à
 * l'intérieur de la sauvegarde de la base. Elle est dérivée, jamais stockée :
 * BAK = HKDF-SHA256(serverKey, salt 'deveye-backup', info 'v1'). Restaurer ne
 * demande que CRYPT_KEY_A/CRYPT_KEY_B et `scripts/restore-backup.mjs` ; les
 * perdre transforme toutes les archives scellées en bruit.
 */

const BACKUP_KEY_SALT = 'deveye-backup';
const BACKUP_KEY_INFO = 'v1';

/** Dérivée par le SDK (`keys.derive`) ; `scripts/restore-backup.mjs` la refait à l'identique. */
export function backupKey(keys: SdkServerKeys): Buffer {
    return Buffer.from(keys.derive(BACKUP_KEY_SALT, BACKUP_KEY_INFO, 32));
}

/**
 * Scelle un clair en `DEVB` v2. Ré-agrège en blocs de {@link BLOB_CHUNK_BYTES}
 * quel que soit le découpage d'entrée : l'ouvreur compte les blocs pour
 * retrouver leur rang.
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

/** Ouvre un flux `DEVB` v2. Lève dès qu'un bloc ne s'authentifie pas : jamais de lecture tolérante. */
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

        // Garder de quoi former un dernier bloc : à exactement `BLOB_CHUNK_SEALED`
        // octets, on ne sait pas s'il est intermédiaire ou final, et l'AAD diffère.
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
