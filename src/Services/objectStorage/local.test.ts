import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { localObjectStore } from './local';

/**
 * Le magasin sur disque est celui de toute installation sans bucket : une clé
 * doit s'y comporter comme dans un bucket, et ne jamais sortir de sa racine.
 */

let root: string;
before(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'deveye-objects-'));
});
after(() => fs.rm(root, { recursive: true, force: true }));

async function read(source: AsyncIterable<Buffer>): Promise<string> {
    const parts: Buffer[] = [];
    for await (const chunk of source) parts.push(chunk);
    return Buffer.concat(parts).toString();
}

async function keys(source: AsyncIterable<{ key: string }>): Promise<string[]> {
    const out: string[] = [];
    for await (const object of source) out.push(object.key);
    return out.sort();
}

async function* chunks(...parts: string[]): AsyncGenerator<Buffer> {
    for (const part of parts) yield Buffer.from(part);
}

describe('le magasin sur disque', () => {
    it('écrit, relit, en entier ou par plage, et dit la taille', async () => {
        const store = localObjectStore(path.join(root, 'rw'));
        assert.deepEqual(await store.put('a/b/c.txt', chunks('bon', 'jour')), { size: 7 });
        assert.equal(await read(store.get('a/b/c.txt')), 'bonjour');
        assert.equal(await read(store.get('a/b/c.txt', { start: 3, end: 5 })), 'jou');
        assert.deepEqual(await store.head('a/b/c.txt'), { size: 7 });
        assert.equal(await store.head('a/b/absent'), null);
    });

    it('liste par préfixe de clé, sans le spool ni une écriture en cours', async () => {
        const base = path.join(root, 'list');
        const store = localObjectStore(base);
        await store.put('ws-1/x', Buffer.from('1'));
        await store.put('ws-1/sous/y', Buffer.from('2'));
        await store.put('ws-10/z', Buffer.from('3'));
        await fs.mkdir(store.spoolDir(), { recursive: true });
        await fs.writeFile(path.join(store.spoolDir(), 'partiel'), 'en cours');
        await fs.writeFile(path.join(base, 'ws-1', 'w.abc.deveye-part'), 'à moitié');
        assert.deepEqual(await keys(store.list('ws-1/')), ['ws-1/sous/y', 'ws-1/x']);
        assert.deepEqual(await keys(store.list('ws-1')), ['ws-1/sous/y', 'ws-1/x', 'ws-10/z']);
        assert.deepEqual(await keys(store.list('')), ['ws-1/sous/y', 'ws-1/x', 'ws-10/z']);
        assert.deepEqual(await keys(store.list('absent/')), []);
    });

    it('installe un fichier du spool, efface une clé puis tout un préfixe', async () => {
        const store = localObjectStore(path.join(root, 'rm'));
        await fs.mkdir(store.spoolDir(), { recursive: true });
        const spooled = path.join(store.spoolDir(), 'fini');
        await fs.writeFile(spooled, 'contenu');
        assert.deepEqual(await store.putFile('p/blobs/fini', spooled), { size: 7 });
        await assert.rejects(fs.access(spooled));
        await store.put('p/autre', Buffer.from('2'));
        await store.put('pp/garde', Buffer.from('3'));

        await store.delete('p/autre');
        await store.delete('p/autre');
        assert.equal(await store.head('p/autre'), null);
        await store.deletePrefix('p/');
        assert.deepEqual(await keys(store.list('')), ['pp/garde']);
    });

    it('refuse une clé qui sortirait de sa racine ou viserait le spool', async () => {
        const store = localObjectStore(path.join(root, 'keys'));
        for (const key of ['../evade', '/abs', 'a//b', 'a/./b', '', '.spool/x', 'nul\0']) {
            await assert.rejects(store.put(key, Buffer.from('x')), /invalide/, key);
        }
        await assert.rejects(store.deletePrefix('sans-barre'), /Préfixe/);
    });
});
