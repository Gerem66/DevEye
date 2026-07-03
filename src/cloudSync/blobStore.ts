import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { BLOB_HEADER_LEN, BLOB_TAG_LEN, createBlobCipher, openBlobDecipher } from './blobCrypto';

/**
 * Blob store adressé par contenu, un par partage, enraciné dans son
 * `storage_path` :
 *   <storage_path>/blobs/<h[0..2]>/<h[2..4]>/<hash>   (chiffré, voir blobCrypto)
 *   <storage_path>/tmp/<aléa>.part                     (écritures en cours)
 *
 * Les blobs sont nommés par le SHA-256 de leur CLAIR : dédup naturelle entre
 * l'index vivant et les versions, et vérification indépendante possible par
 * l'agent. Une écriture calcule le hash au fil de l'eau et n'est installée
 * (rename atomique) que si le résultat correspond à l'annonce — sinon rien
 * n'est modifié.
 */

const READ_CHUNK = 256 * 1024;

/**
 * Les SEULS sous-dossiers que le store possède dans un `storage_path`. La
 * validation de chemin les tolère (réutilisation d'un ancien stockage) et la
 * suppression d'un partage n'efface QUE ceux-là — jamais le dossier entier.
 */
export const BLOB_STORE_SUBDIRS = ['blobs', 'tmp'] as const;
const [BLOBS_DIR, TMP_DIR] = BLOB_STORE_SUBDIRS;

export class BlobHashMismatchError extends Error {
    constructor(expected: string, actual: string) {
        super(`CloudSync : hash de blob inattendu (attendu ${expected}, obtenu ${actual})`);
    }
}

export interface BlobWriter {
    write(bytes: Buffer): Promise<void>;
    /** Scelle le blob : vérifie le hash, fsync, rename dans le CAS. */
    finalize(): Promise<{ hash: string; size: number }>;
    /** Abandonne proprement (le fichier temporaire est supprimé). */
    abort(): Promise<void>;
}

export class ShareBlobStore {
    private readonly blobsDir: string;
    private readonly tmpDir: string;

    constructor(
        readonly root: string,
        private readonly bmk: Buffer
    ) {
        this.blobsDir = path.join(root, BLOBS_DIR);
        this.tmpDir = path.join(root, TMP_DIR);
    }

    /** Crée l'arborescence du store (idempotent) et balaye les temporaires orphelins. */
    async init(): Promise<void> {
        await fs.mkdir(this.blobsDir, { recursive: true });
        await fs.mkdir(this.tmpDir, { recursive: true });
        for (const name of await fs.readdir(this.tmpDir)) {
            await fs.rm(path.join(this.tmpDir, name), { force: true });
        }
    }

    private blobPath(hash: string): string {
        return path.join(this.blobsDir, hash.slice(0, 2), hash.slice(2, 4), hash);
    }

    async has(hash: string): Promise<boolean> {
        try {
            await fs.access(this.blobPath(hash));
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Ouvre une écriture. `expectedHash` (quand connu, i.e. annoncé par le
     * scan de l'agent) est vérifié à la finalisation — un écart lève
     * {@link BlobHashMismatchError} et ne touche à rien.
     */
    async openWrite(expectedHash: string | null): Promise<BlobWriter> {
        const tmpPath = path.join(this.tmpDir, `${crypto.randomBytes(16).toString('hex')}.part`);
        const fh = await fs.open(tmpPath, 'wx');
        const { header, cipher } = createBlobCipher(this.bmk);
        await fh.write(header);
        const plainHash = crypto.createHash('sha256');
        let size = 0;
        let open = true;

        const discard = async () => {
            open = false;
            await fh.close().catch(() => undefined);
            await fs.rm(tmpPath, { force: true });
        };

        return {
            write: async (bytes) => {
                if (!open) throw new Error('CloudSync : écriture sur un blob déjà scellé');
                plainHash.update(bytes);
                size += bytes.length;
                const enc = cipher.update(bytes);
                if (enc.length > 0) await fh.write(enc);
            },
            finalize: async () => {
                if (!open) throw new Error('CloudSync : blob déjà scellé');
                const tail = Buffer.concat([cipher.final(), cipher.getAuthTag()]);
                await fh.write(tail);
                await fh.sync();
                await fh.close();
                open = false;
                const hash = plainHash.digest('hex');
                if (expectedHash !== null && hash !== expectedHash) {
                    await fs.rm(tmpPath, { force: true });
                    throw new BlobHashMismatchError(expectedHash, hash);
                }
                const dest = this.blobPath(hash);
                await fs.mkdir(path.dirname(dest), { recursive: true });
                // Rename atomique ; un blob identique déjà présent est simplement remplacé.
                await fs.rename(tmpPath, dest);
                return { hash, size };
            },
            abort: discard
        };
    }

    /**
     * Lit un blob en flux, déchiffré et doublement vérifié : tag GCM à la fin
     * ET SHA-256 du clair comparé au nom. Toute anomalie lève avant que le
     * dernier chunk ne soit livré.
     */
    async *read(hash: string): AsyncGenerator<Buffer> {
        const fh = await fs.open(this.blobPath(hash), 'r');
        try {
            const { size: fileSize } = await fh.stat();
            if (fileSize < BLOB_HEADER_LEN + BLOB_TAG_LEN) {
                throw new Error('CloudSync : blob corrompu (tronqué)');
            }
            const header = Buffer.alloc(BLOB_HEADER_LEN);
            await fh.read(header, 0, BLOB_HEADER_LEN, 0);
            const decipher = openBlobDecipher(this.bmk, header);

            const cipherEnd = fileSize - BLOB_TAG_LEN;
            const tag = Buffer.alloc(BLOB_TAG_LEN);
            await fh.read(tag, 0, BLOB_TAG_LEN, cipherEnd);
            decipher.setAuthTag(tag);

            const plainHash = crypto.createHash('sha256');
            let pos = BLOB_HEADER_LEN;
            const buf = Buffer.alloc(READ_CHUNK);
            while (pos < cipherEnd) {
                const want = Math.min(READ_CHUNK, cipherEnd - pos);
                const { bytesRead } = await fh.read(buf, 0, want, pos);
                if (bytesRead <= 0) throw new Error('CloudSync : blob corrompu (lecture courte)');
                pos += bytesRead;
                const plain = decipher.update(buf.subarray(0, bytesRead));
                if (plain.length > 0) {
                    plainHash.update(plain);
                    // `plain` référence le buffer interne du decipher : copie avant yield.
                    yield Buffer.from(plain);
                }
            }
            const last = decipher.final(); // Lève si le tag GCM ne colle pas.
            if (last.length > 0) {
                plainHash.update(last);
            }
            const actual = plainHash.digest('hex');
            if (actual !== hash) throw new BlobHashMismatchError(hash, actual);
            if (last.length > 0) yield Buffer.from(last);
        } finally {
            await fh.close().catch(() => undefined);
        }
    }

    /** Destruction physique — ne passer QUE par `gcBlobIfUnreferenced` (versions.ts). */
    async deleteBlob(hash: string): Promise<void> {
        await fs.rm(this.blobPath(hash), { force: true });
    }
}

/** Un store par `storage_path`, initialisé paresseusement et mis en cache. */
export class BlobStoreCache {
    private readonly stores = new Map<string, Promise<ShareBlobStore>>();

    constructor(private readonly bmk: Buffer) {}

    for(storagePath: string): Promise<ShareBlobStore> {
        let entry = this.stores.get(storagePath);
        if (!entry) {
            entry = (async () => {
                const store = new ShareBlobStore(storagePath, this.bmk);
                await store.init();
                return store;
            })();
            this.stores.set(storagePath, entry);
        }
        return entry;
    }

    /** À la suppression d'un partage (le dossier peut disparaître derrière). */
    drop(storagePath: string): void {
        this.stores.delete(storagePath);
    }
}
