import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BLOB_CHUNK_BYTES } from '@deveye/types/sdk/server';

import { diskBlobStore, openBlob, sealBlob } from './blobs';

const key = crypto.randomBytes(32);

test('un corps se relit tel quel, vide, court, ou plus long qu’un bloc', () => {
    for (const size of [0, 1, 4096, BLOB_CHUNK_BYTES, BLOB_CHUNK_BYTES + 17, BLOB_CHUNK_BYTES * 2 + 5]) {
        const data = crypto.randomBytes(size);
        assert.ok(openBlob(key, sealBlob(key, data)).equals(data), `taille ${size}`);
    }
});

test('une autre clé, ou un octet retouché, ne s’ouvrent pas', () => {
    const sealed = sealBlob(key, Buffer.from('bonjour'));
    assert.throws(() => openBlob(crypto.randomBytes(32), sealed));
    sealed[sealed.length - 1] ^= 1;
    assert.throws(() => openBlob(key, sealed));
});

test('le disque : écrire, relire, retirer, purger une boîte', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mailserver-blobs-'));
    try {
        const store = diskBlobStore(root);
        const ref = await store.write(7, key, Buffer.from('un message'));
        assert.equal((await store.read(7, key, ref)).toString(), 'un message');
        // Le fichier ne porte rien de lisible.
        const onDisk = await fs.readFile(path.join(root, '7', ref.slice(0, 2), ref));
        assert.ok(!onDisk.includes('un message'));

        await store.remove(7, ref);
        await assert.rejects(store.read(7, key, ref));
        await store.remove(7, ref);

        await store.write(7, key, Buffer.from('autre'));
        await store.purge(7);
        await assert.rejects(fs.stat(path.join(root, '7')));
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('le disque en flux : ouvert avant la lecture, il survit à un effacement', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mailserver-blobs-'));
    try {
        const store = diskBlobStore(root);
        const body = crypto.randomBytes(3 * 1024 * 1024 + 17);
        const ref = await store.write(7, key, body);
        const stream = await store.open(7, key, ref);
        assert.ok(stream);
        await store.remove(7, ref);
        const parts: Buffer[] = [];
        for await (const chunk of stream) parts.push(chunk);
        assert.ok(Buffer.concat(parts).equals(body));
        assert.equal(await store.open(7, key, ref), null);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});
