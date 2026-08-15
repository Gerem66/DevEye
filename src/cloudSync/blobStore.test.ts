import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { BLOB_CHUNK_BYTES, BLOB_HEADER_LEN, BLOB_TAG_LEN, BLOB_VERSION_STREAM } from './blobCrypto';
import { BlobHashMismatchError, ShareBlobStore } from './blobStore';

/**
 * Le blob store est la seule pièce qui touche VRAIMENT aux octets des
 * utilisateurs. Deux choses doivent être prouvées, pas supposées :
 *  - un blob écrit à l'ancien format (`0x01`) reste lisible après la bascule ;
 *  - une écriture coupée peut reprendre sans jamais livrer un contenu faux.
 */

const BMK = Buffer.alloc(32, 7);
let root: string;
let store: ShareBlobStore;

const sha = (b: Buffer): string => crypto.createHash('sha256').update(b).digest('hex');

async function collect(hash: string, skip = 0): Promise<Buffer> {
    const parts: Buffer[] = [];
    for await (const chunk of store.read(hash, skip)) parts.push(chunk);
    return Buffer.concat(parts);
}

/** Écrit un blob au format historique v1 (flux GCM unique), comme avant la bascule. */
async function writeLegacyBlob(plain: Buffer): Promise<string> {
    const hash = sha(plain);
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', BMK, nonce);
    const body = Buffer.concat([cipher.update(plain), cipher.final()]);
    const blob = Buffer.concat([
        Buffer.from('DEVB'),
        Buffer.from([BLOB_VERSION_STREAM]),
        nonce,
        body,
        cipher.getAuthTag()
    ]);
    const dest = path.join(root, 'blobs', hash.slice(0, 2), hash.slice(2, 4), hash);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, blob);
    return hash;
}

before(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'deveye-blob-'));
    store = new ShareBlobStore(root, BMK);
    await store.init();
});

after(async () => {
    await fs.rm(root, { recursive: true, force: true });
});

describe('blobStore — rétro-compatibilité du format', () => {
    it('lit encore un blob écrit à l’ancien format 0x01', async () => {
        // LE test de la passe : les blobs déjà sur disque ne doivent pas devenir
        // illisibles parce qu'on a introduit un nouveau format d'écriture.
        const plain = crypto.randomBytes(3 * BLOB_CHUNK_BYTES + 1234);
        const hash = await writeLegacyBlob(plain);
        assert.deepEqual(await collect(hash), plain);
    });

    it('détecte un blob 0x01 corrompu', async () => {
        const plain = crypto.randomBytes(4096);
        const hash = await writeLegacyBlob(plain);
        const dest = path.join(root, 'blobs', hash.slice(0, 2), hash.slice(2, 4), hash);
        const raw = await fs.readFile(dest);
        raw[BLOB_HEADER_LEN + 10] ^= 0xff;
        await fs.writeFile(dest, raw);
        await assert.rejects(() => collect(hash));
    });

    it('écrit désormais au format 0x02', async () => {
        const plain = crypto.randomBytes(1000);
        const w = await store.openWrite(sha(plain));
        await w.write(plain);
        const { hash } = await w.finalize();
        const raw = await fs.readFile(path.join(root, 'blobs', hash.slice(0, 2), hash.slice(2, 4), hash));
        assert.equal(raw[4], 0x02);
    });
});

describe('blobStore — aller-retour et vérification', () => {
    it('restitue exactement le contenu, sur plusieurs blocs', async () => {
        const plain = crypto.randomBytes(2 * BLOB_CHUNK_BYTES + 777);
        const w = await store.openWrite(sha(plain));
        // Écrit en morceaux irréguliers : les frontières de blocs ne doivent pas
        // dépendre de la façon dont l'appelant découpe.
        for (let i = 0; i < plain.length; i += 33_333) {
            await w.write(plain.subarray(i, Math.min(i + 33_333, plain.length)));
        }
        const { hash, size } = await w.finalize();
        assert.equal(hash, sha(plain));
        assert.equal(size, plain.length);
        assert.deepEqual(await collect(hash), plain);
    });

    it('gère le contenu vide et le bloc exactement plein', async () => {
        for (const plain of [Buffer.alloc(0), crypto.randomBytes(BLOB_CHUNK_BYTES)]) {
            const w = await store.openWrite(sha(plain));
            await w.write(plain);
            const { hash } = await w.finalize();
            assert.deepEqual(await collect(hash), plain);
        }
    });

    it('refuse un contenu qui ne correspond pas au hash annoncé', async () => {
        const w = await store.openWrite(sha(Buffer.from('attendu')));
        await w.write(Buffer.from('reçu'));
        await assert.rejects(() => w.finalize(), BlobHashMismatchError);
    });

    it('détecte un blob 0x02 tronqué de son dernier bloc', async () => {
        // Le marqueur de fin dans l'AAD est là pour ça : couper la queue ne doit
        // jamais pouvoir passer pour un blob complet.
        const plain = crypto.randomBytes(2 * BLOB_CHUNK_BYTES + 10);
        const w = await store.openWrite(sha(plain));
        await w.write(plain);
        const { hash } = await w.finalize();
        const dest = path.join(root, 'blobs', hash.slice(0, 2), hash.slice(2, 4), hash);
        const raw = await fs.readFile(dest);
        await fs.writeFile(dest, raw.subarray(0, BLOB_HEADER_LEN + BLOB_CHUNK_BYTES + BLOB_TAG_LEN));
        await assert.rejects(() => collect(hash));
    });

    it('saute des octets de clair sans cesser de vérifier le tout', async () => {
        const plain = crypto.randomBytes(BLOB_CHUNK_BYTES + 5000);
        const w = await store.openWrite(sha(plain));
        await w.write(plain);
        const { hash } = await w.finalize();
        const skip = BLOB_CHUNK_BYTES + 100;
        assert.deepEqual(await collect(hash, skip), plain.subarray(skip));
        assert.deepEqual(await collect(hash, plain.length), Buffer.alloc(0));
    });
});

describe('blobStore — reprise', () => {
    it('reprend un transfert coupé au lieu de tout recommencer', async () => {
        const plain = crypto.randomBytes(3 * BLOB_CHUNK_BYTES + 4242);
        const hash = sha(plain);

        const first = await store.openWrite(hash);
        assert.equal(first.resumeFrom, 0);
        await first.write(plain.subarray(0, 2 * BLOB_CHUNK_BYTES + 900));
        await first.suspend(); // Coupure : le partiel doit SURVIVRE.

        const second = await store.openWrite(hash);
        // Seuls les blocs complets sont conservés — la queue partielle est jetée.
        assert.equal(second.resumeFrom, 2 * BLOB_CHUNK_BYTES);
        await second.write(plain.subarray(second.resumeFrom));
        const out = await second.finalize();
        assert.equal(out.hash, hash);
        assert.deepEqual(await collect(hash), plain);
    });

    it('survit à un redémarrage : init() ne détruit pas un partiel récent', async () => {
        const plain = crypto.randomBytes(2 * BLOB_CHUNK_BYTES);
        const hash = sha(plain);
        const first = await store.openWrite(hash);
        await first.write(plain.subarray(0, BLOB_CHUNK_BYTES + 10));
        await first.suspend();

        const rebooted = new ShareBlobStore(root, BMK);
        await rebooted.init();
        const second = await rebooted.openWrite(hash);
        assert.equal(second.resumeFrom, BLOB_CHUNK_BYTES);
        await second.write(plain.subarray(BLOB_CHUNK_BYTES));
        assert.equal((await second.finalize()).hash, hash);
    });

    it('repart de zéro plutôt que de bâtir sur un partiel corrompu', async () => {
        const plain = crypto.randomBytes(2 * BLOB_CHUNK_BYTES);
        const hash = sha(plain);
        const first = await store.openWrite(hash);
        await first.write(plain.subarray(0, BLOB_CHUNK_BYTES + 10));
        await first.suspend();

        const partial = path.join(root, 'tmp', `${hash}.part`);
        const raw = await fs.readFile(partial);
        raw[BLOB_HEADER_LEN + 50] ^= 0xff;
        await fs.writeFile(partial, raw);

        const second = await store.openWrite(hash);
        assert.equal(second.resumeFrom, 0, 'un partiel douteux ne doit jamais être réutilisé');
        await second.write(plain);
        assert.equal((await second.finalize()).hash, hash);
    });

    it('abort() détruit le partiel, suspend() le garde', async () => {
        const plain = crypto.randomBytes(BLOB_CHUNK_BYTES + 1);
        const hash = sha(plain);
        const w = await store.openWrite(hash);
        await w.write(plain);
        await w.abort();
        const next = await store.openWrite(hash);
        assert.equal(next.resumeFrom, 0);
        await next.abort();
    });
});
