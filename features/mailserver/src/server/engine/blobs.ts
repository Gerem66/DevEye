import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
    BLOB_CHUNK_BYTES,
    BLOB_CHUNK_SEALED,
    BLOB_HEADER_LEN,
    createBlobHeader,
    openChunk,
    parseBlobHeader,
    sealChunk
} from '@deveye/types/sdk/server';

/**
 * Les corps des messages, hors base : un fichier par message, au format DEVB
 * v2 du SDK, sous la clé de sa boîte. Un message est borné par le plafond du
 * serveur (quelques dizaines de Mio), donc lu et écrit d'un bloc.
 */
export interface BlobStore {
    /** Écrit un corps et rend la référence sous laquelle le relire. */
    write(mailboxId: number, key: Buffer, data: Buffer): Promise<string>;
    read(mailboxId: number, key: Buffer, ref: string): Promise<Buffer>;
    remove(mailboxId: number, ref: string): Promise<void>;
    /** Tout ce que la boîte a sur le disque. */
    purge(mailboxId: number): Promise<void>;
}

export function sealBlob(key: Buffer, data: Buffer): Buffer {
    const header = createBlobHeader();
    const { nonce } = parseBlobHeader(header);
    const parts: Buffer[] = [header];
    const chunks = Math.max(1, Math.ceil(data.length / BLOB_CHUNK_BYTES));
    for (let index = 0; index < chunks; index += 1) {
        const plain = data.subarray(index * BLOB_CHUNK_BYTES, (index + 1) * BLOB_CHUNK_BYTES);
        parts.push(sealChunk(key, nonce, index, plain, index === chunks - 1));
    }
    return Buffer.concat(parts);
}

export function openBlob(key: Buffer, sealed: Buffer): Buffer {
    const { nonce } = parseBlobHeader(sealed.subarray(0, BLOB_HEADER_LEN));
    const body = sealed.subarray(BLOB_HEADER_LEN);
    const chunks = Math.max(1, Math.ceil(body.length / BLOB_CHUNK_SEALED));
    const parts: Buffer[] = [];
    for (let index = 0; index < chunks; index += 1) {
        const chunk = body.subarray(index * BLOB_CHUNK_SEALED, (index + 1) * BLOB_CHUNK_SEALED);
        parts.push(openChunk(key, nonce, index, chunk, index === chunks - 1));
    }
    return Buffer.concat(parts);
}

export function diskBlobStore(root: string): BlobStore {
    // Deux caractères de la référence font un sous-dossier : une boîte de cent
    // mille messages ne met pas cent mille fichiers dans le même répertoire.
    const fileOf = (mailboxId: number, ref: string): string => path.join(root, String(mailboxId), ref.slice(0, 2), ref);

    return {
        async write(mailboxId, key, data) {
            const ref = crypto.randomBytes(16).toString('hex');
            const file = fileOf(mailboxId, ref);
            await fs.mkdir(path.dirname(file), { recursive: true });
            // Écrit à côté puis renommé : un arrêt en pleine écriture ne laisse
            // jamais un corps tronqué sous un nom que la base connaît.
            const partial = `${file}.part`;
            await fs.writeFile(partial, sealBlob(key, data), { mode: 0o600 });
            await fs.rename(partial, file);
            return ref;
        },
        read: async (mailboxId, key, ref) => openBlob(key, await fs.readFile(fileOf(mailboxId, ref))),
        remove: (mailboxId, ref) => fs.rm(fileOf(mailboxId, ref), { force: true }),
        purge: (mailboxId) => fs.rm(path.join(root, String(mailboxId)), { recursive: true, force: true })
    };
}

/** Le même contrat en mémoire, scellé compris : pour les tests. */
export function memoryBlobStore(): BlobStore & { files: Map<string, Buffer> } {
    const files = new Map<string, Buffer>();
    return {
        files,
        write(mailboxId, key, data) {
            const ref = crypto.randomBytes(16).toString('hex');
            files.set(`${mailboxId}/${ref}`, sealBlob(key, data));
            return Promise.resolve(ref);
        },
        read(mailboxId, key, ref) {
            const sealed = files.get(`${mailboxId}/${ref}`);
            return sealed ? Promise.resolve(openBlob(key, sealed)) : Promise.reject(new Error('ENOENT'));
        },
        remove(mailboxId, ref) {
            files.delete(`${mailboxId}/${ref}`);
            return Promise.resolve();
        },
        purge(mailboxId) {
            for (const name of [...files.keys()]) if (name.startsWith(`${mailboxId}/`)) files.delete(name);
            return Promise.resolve();
        }
    };
}
