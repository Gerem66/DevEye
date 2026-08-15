import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import {
    BLOB_CHUNK_BYTES,
    BLOB_CHUNK_SEALED,
    BLOB_HEADER_LEN,
    BLOB_TAG_LEN,
    BLOB_VERSION_CHUNKED,
    createBlobHeader,
    openChunk,
    openStreamDecipher,
    parseBlobHeader,
    sealChunk
} from './blobCrypto';

/**
 * Blob store adressé par contenu, un par partage, enraciné dans son
 * `storage_path` :
 *   <storage_path>/blobs/<h[0..2]>/<h[2..4]>/<hash>   (chiffré, voir blobCrypto)
 *   <storage_path>/tmp/<hash>.part                     (écritures en cours)
 *
 * Les blobs sont nommés par le SHA-256 de leur CLAIR : dédup naturelle entre
 * l'index vivant et les versions, et vérification indépendante possible par
 * l'agent. Une écriture calcule le hash au fil de l'eau et n'est installée
 * (rename atomique) que si le résultat correspond à l'annonce — sinon rien
 * n'est modifié.
 *
 * **Les partiels sont nommés par le hash attendu**, et non par un aléa : c'est
 * ce qui permet de reprendre un transfert coupé au lieu de tout recommencer.
 * Et c'est auto-correctif — si le fichier source a changé entre-temps, son hash
 * a changé, donc le partiel visé n'est plus le même : aucune reprise sur des
 * octets périmés n'est possible.
 */

const READ_CHUNK = 256 * 1024;

/**
 * Les SEULS sous-dossiers que le store possède dans un `storage_path`. La
 * validation de chemin les tolère (réutilisation d'un ancien stockage) et la
 * suppression d'un partage n'efface QUE ceux-là — jamais le dossier entier.
 */
export const BLOB_STORE_SUBDIRS = ['blobs', 'tmp'] as const;
const [BLOBS_DIR, TMP_DIR] = BLOB_STORE_SUBDIRS;

/** Au-delà, un partiel abandonné est balayé (transfert jamais repris). */
const PARTIAL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export class BlobHashMismatchError extends Error {
    constructor(expected: string, actual: string) {
        super(`CloudSync : hash de blob inattendu (attendu ${expected}, obtenu ${actual})`);
    }
}

export interface BlobWriter {
    /** Octets de clair déjà en place — le point de reprise à demander à l'agent. */
    readonly resumeFrom: number;
    write(bytes: Buffer): Promise<void>;
    /** Scelle le blob : vérifie le hash, fsync, rename dans le CAS. */
    finalize(): Promise<{ hash: string; size: number }>;
    /** Abandonne l'écriture EN GARDANT le partiel, pour une reprise ultérieure. */
    suspend(): Promise<void>;
    /** Abandonne et détruit le partiel (contenu devenu inutile ou invalide). */
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

    /**
     * Crée l'arborescence du store (idempotent) et balaye les temporaires.
     *
     * Attention : ce balayage ne peut plus être un `rm` aveugle. Les partiels
     * `<hash>.part` portent le travail déjà transféré d'une reprise — les
     * effacer au démarrage annulerait précisément ce qu'ils servent à sauver.
     * Seuls partent les partiels vraiment abandonnés et les temporaires
     * anonymes de l'ancien format.
     */
    async init(): Promise<void> {
        await fs.mkdir(this.blobsDir, { recursive: true });
        await fs.mkdir(this.tmpDir, { recursive: true });
        const now = Date.now();
        for (const name of await fs.readdir(this.tmpDir)) {
            const full = path.join(this.tmpDir, name);
            const resumable = /^[a-f0-9]{64}\.part$/.test(name);
            if (!resumable) {
                await fs.rm(full, { force: true });
                continue;
            }
            const stat = await fs.stat(full).catch(() => null);
            if (stat === null || now - stat.mtimeMs > PARTIAL_MAX_AGE_MS) {
                await fs.rm(full, { force: true });
            }
        }
    }

    private blobPath(hash: string): string {
        return path.join(this.blobsDir, hash.slice(0, 2), hash.slice(2, 4), hash);
    }

    private partialPath(hash: string): string {
        return path.join(this.tmpDir, `${hash}.part`);
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
     * Ouvre une écriture, en REPRENANT le partiel de `expectedHash` s'il en
     * existe un d'exploitable. La reprise relit les blocs déjà écrits pour
     * reconstituer le SHA-256 courant : c'est de l'I/O locale, jamais du
     * réseau. Un partiel illisible (bloc corrompu, format inattendu) est
     * simplement jeté et l'écriture repart de zéro — jamais d'échec bloquant.
     *
     * `expectedHash` est vérifié à la finalisation ; un écart lève
     * {@link BlobHashMismatchError} et ne touche à rien.
     */
    async openWrite(expectedHash: string | null): Promise<BlobWriter> {
        if (expectedHash === null) return this.freshWriter(null);
        const resumed = await this.resumeWriter(expectedHash).catch(() => null);
        return resumed ?? this.freshWriter(expectedHash);
    }

    /** Relit un partiel existant pour en déduire l'état de reprise, ou `null`. */
    private async resumeWriter(expectedHash: string): Promise<BlobWriter | null> {
        const tmpPath = this.partialPath(expectedHash);
        const stat = await fs.stat(tmpPath).catch(() => null);
        if (stat === null || stat.size <= BLOB_HEADER_LEN) return null;

        const fh = await fs.open(tmpPath, 'r+');
        try {
            const header = Buffer.alloc(BLOB_HEADER_LEN);
            await fh.read(header, 0, BLOB_HEADER_LEN, 0);
            const { version, nonce } = parseBlobHeader(header);
            // Un partiel v1 ne se reprend pas (l'état du cipher est perdu).
            if (version !== BLOB_VERSION_CHUNKED) return null;

            // Seuls les blocs COMPLETS comptent : une écriture coupée en plein
            // bloc laisse une queue partielle, qu'on tronque.
            const body = stat.size - BLOB_HEADER_LEN;
            const complete = Math.floor(body / BLOB_CHUNK_SEALED);
            if (complete === 0) return null;

            const plainHash = crypto.createHash('sha256');
            const buf = Buffer.alloc(BLOB_CHUNK_SEALED);
            let size = 0;
            for (let index = 0; index < complete; index += 1) {
                const at = BLOB_HEADER_LEN + index * BLOB_CHUNK_SEALED;
                await fh.read(buf, 0, BLOB_CHUNK_SEALED, at);
                // `final: false` : un bloc complet au milieu n'est jamais le
                // dernier. S'il l'était, son tag ne collerait pas et on repart
                // de zéro — le bon échec.
                const plain = openChunk(this.bmk, nonce, index, buf, false);
                plainHash.update(plain);
                size += plain.length;
            }
            const end = BLOB_HEADER_LEN + complete * BLOB_CHUNK_SEALED;
            await fh.truncate(end);
            return this.makeWriter(fh, tmpPath, expectedHash, nonce, plainHash, size, complete, end);
        } catch (err) {
            await fh.close().catch(() => undefined);
            await fs.rm(tmpPath, { force: true });
            throw err;
        }
    }

    private async freshWriter(expectedHash: string | null): Promise<BlobWriter> {
        const tmpPath =
            expectedHash === null
                ? path.join(this.tmpDir, `${crypto.randomBytes(16).toString('hex')}.tmp`)
                : this.partialPath(expectedHash);
        await fs.rm(tmpPath, { force: true });
        const fh = await fs.open(tmpPath, 'wx');
        const header = createBlobHeader();
        await fh.write(header, 0, header.length, 0);
        const { nonce } = parseBlobHeader(header);
        return this.makeWriter(fh, tmpPath, expectedHash, nonce, crypto.createHash('sha256'), 0, 0, BLOB_HEADER_LEN);
    }

    private makeWriter(
        fh: fs.FileHandle,
        tmpPath: string,
        expectedHash: string | null,
        nonce: Buffer,
        plainHash: crypto.Hash,
        startSize: number,
        startIndex: number,
        startPos: number
    ): BlobWriter {
        let size = startSize;
        let index = startIndex;
        // Position d'écriture SUIVIE explicitement : un handle rouvert en `r+`
        // pour une reprise a sa position implicite à 0, et un `write()` sans
        // position y écraserait l'en-tête. Les deux chemins passent donc par
        // une position calculée.
        let writePos = startPos;
        let pending: Buffer = Buffer.alloc(0);
        let open = true;

        const append = async (sealed: Buffer): Promise<void> => {
            await fh.write(sealed, 0, sealed.length, writePos);
            writePos += sealed.length;
        };

        const close = async (keepPartial: boolean) => {
            if (!open) return;
            open = false;
            await fh.close().catch(() => undefined);
            if (!keepPartial) await fs.rm(tmpPath, { force: true });
        };

        return {
            resumeFrom: startSize,
            write: async (bytes) => {
                if (!open) throw new Error('CloudSync : écriture sur un blob déjà scellé');
                plainHash.update(bytes);
                size += bytes.length;
                pending = pending.length === 0 ? bytes : Buffer.concat([pending, bytes]);
                // Seuls les blocs PLEINS partent sur le disque : c'est ce qui
                // garantit qu'un partiel se relit bloc par bloc à la reprise.
                while (pending.length >= BLOB_CHUNK_BYTES) {
                    const plain = pending.subarray(0, BLOB_CHUNK_BYTES);
                    await append(sealChunk(this.bmk, nonce, index, plain, false));
                    pending = pending.subarray(BLOB_CHUNK_BYTES);
                    index += 1;
                }
            },
            finalize: async () => {
                if (!open) throw new Error('CloudSync : blob déjà scellé');
                // Le bloc final porte le marqueur de fin : un blob tronqué ne
                // peut donc pas passer pour complet.
                await append(sealChunk(this.bmk, nonce, index, pending, true));
                await fh.sync();
                await close(true);
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
            suspend: () => close(true),
            abort: () => close(false)
        };
    }

    /**
     * Lit un blob en flux, déchiffré et doublement vérifié : scellés GCM ET
     * SHA-256 du clair comparé au nom. Toute anomalie lève avant que le
     * dernier chunk ne soit livré. Les deux formats sont servis : v1 (flux
     * unique, blobs historiques) et v2 (scellé par blocs).
     *
     * `skipBytes` saute des octets de CLAIR sans les livrer — la reprise d'un
     * download s'en sert. Le hash global reste calculé sur la totalité, donc
     * une reprise ne fait jamais l'impasse sur la vérification.
     */
    async *read(hash: string, skipBytes = 0): AsyncGenerator<Buffer> {
        const fh = await fs.open(this.blobPath(hash), 'r');
        try {
            const { size: fileSize } = await fh.stat();
            if (fileSize < BLOB_HEADER_LEN + BLOB_TAG_LEN) {
                throw new Error('CloudSync : blob corrompu (tronqué)');
            }
            const header = Buffer.alloc(BLOB_HEADER_LEN);
            await fh.read(header, 0, BLOB_HEADER_LEN, 0);
            const { version, nonce } = parseBlobHeader(header);
            const plainHash = crypto.createHash('sha256');
            let delivered = 0;

            /** Livre du clair en respectant `skipBytes`, et alimente le hash. */
            const emit = function* (plain: Buffer): Generator<Buffer> {
                plainHash.update(plain);
                const start = delivered;
                delivered += plain.length;
                if (delivered <= skipBytes) return;
                const from = start >= skipBytes ? 0 : skipBytes - start;
                yield from === 0 ? Buffer.from(plain) : Buffer.from(plain.subarray(from));
            };

            if (version === BLOB_VERSION_CHUNKED) {
                const body = fileSize - BLOB_HEADER_LEN;
                const chunks = Math.ceil(body / BLOB_CHUNK_SEALED);
                const buf = Buffer.alloc(BLOB_CHUNK_SEALED);
                for (let index = 0; index < chunks; index += 1) {
                    const at = BLOB_HEADER_LEN + index * BLOB_CHUNK_SEALED;
                    const want = Math.min(BLOB_CHUNK_SEALED, fileSize - at);
                    const { bytesRead } = await fh.read(buf, 0, want, at);
                    if (bytesRead <= 0) throw new Error('CloudSync : blob corrompu (lecture courte)');
                    const last = index === chunks - 1;
                    yield* emit(openChunk(this.bmk, nonce, index, buf.subarray(0, bytesRead), last));
                }
            } else {
                const decipher = openStreamDecipher(this.bmk, nonce);
                const cipherEnd = fileSize - BLOB_TAG_LEN;
                const tag = Buffer.alloc(BLOB_TAG_LEN);
                await fh.read(tag, 0, BLOB_TAG_LEN, cipherEnd);
                decipher.setAuthTag(tag);
                let pos = BLOB_HEADER_LEN;
                const buf = Buffer.alloc(READ_CHUNK);
                while (pos < cipherEnd) {
                    const want = Math.min(READ_CHUNK, cipherEnd - pos);
                    const { bytesRead } = await fh.read(buf, 0, want, pos);
                    if (bytesRead <= 0) throw new Error('CloudSync : blob corrompu (lecture courte)');
                    pos += bytesRead;
                    const plain = decipher.update(buf.subarray(0, bytesRead));
                    if (plain.length > 0) yield* emit(plain);
                }
                const last = decipher.final(); // Lève si le tag GCM ne colle pas.
                if (last.length > 0) yield* emit(last);
            }

            const actual = plainHash.digest('hex');
            if (actual !== hash) throw new BlobHashMismatchError(hash, actual);
        } finally {
            await fh.close().catch(() => undefined);
        }
    }

    /**
     * Relit un blob de bout en bout sans rien livrer, pour le seul contrôle
     * d'intégrité (scellés + SHA-256). Rend les octets de clair vérifiés.
     */
    async verify(hash: string): Promise<number> {
        let bytes = 0;
        for await (const chunk of this.read(hash)) bytes += chunk.length;
        return bytes;
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
