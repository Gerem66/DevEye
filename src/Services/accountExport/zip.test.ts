import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import zlib from 'node:zlib';

import { ZipWriter, type ZipOptions } from './zip';

interface Read {
    name: string;
    data: Buffer;
    method: number;
    flags: number;
}

/** Un lecteur minimal, par le répertoire central comme les vrais : ZIP64 compris, CRC vérifié. */
function readZip(buf: Buffer): Read[] {
    const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    assert.ok(eocd >= 0, 'fin d’archive absente');
    let count = buf.readUInt16LE(eocd + 10);
    let cdOffset = buf.readUInt32LE(eocd + 16);
    if (count === 0xffff || cdOffset === 0xffffffff) {
        const locator = eocd - 20;
        assert.equal(buf.readUInt32LE(locator), 0x07064b50, 'localisateur ZIP64 absent');
        const end64 = Number(buf.readBigUInt64LE(locator + 8));
        assert.equal(buf.readUInt32LE(end64), 0x06064b50);
        count = Number(buf.readBigUInt64LE(end64 + 32));
        cdOffset = Number(buf.readBigUInt64LE(end64 + 48));
    }
    const out: Read[] = [];
    let p = cdOffset;
    for (let i = 0; i < count; i++) {
        assert.equal(buf.readUInt32LE(p), 0x02014b50);
        const flags = buf.readUInt16LE(p + 8);
        const method = buf.readUInt16LE(p + 10);
        const crc = buf.readUInt32LE(p + 16);
        let compressed = buf.readUInt32LE(p + 20);
        let size = buf.readUInt32LE(p + 24);
        const nameLen = buf.readUInt16LE(p + 28);
        const extraLen = buf.readUInt16LE(p + 30);
        let offset = buf.readUInt32LE(p + 42);
        const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
        let e = p + 46 + nameLen;
        const extraEnd = e + extraLen;
        while (e < extraEnd) {
            const id = buf.readUInt16LE(e);
            const len = buf.readUInt16LE(e + 2);
            if (id === 0x0001) {
                let f = e + 4;
                if (size === 0xffffffff) {
                    size = Number(buf.readBigUInt64LE(f));
                    f += 8;
                }
                if (compressed === 0xffffffff) {
                    compressed = Number(buf.readBigUInt64LE(f));
                    f += 8;
                }
                if (offset === 0xffffffff) offset = Number(buf.readBigUInt64LE(f));
            }
            e += 4 + len;
        }
        assert.equal(buf.readUInt32LE(offset), 0x04034b50, `en-tête local de ${name}`);
        const start = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
        const raw = buf.subarray(start, start + compressed);
        const data = method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);
        assert.equal(data.length, size, `taille de ${name}`);
        assert.equal(zlib.crc32(data), crc, `CRC de ${name}`);
        out.push({ name, data, method, flags });
        p = extraEnd + buf.readUInt16LE(p + 32);
    }
    return out;
}

async function build(
    fill: (zip: ZipWriter) => Promise<void>,
    opts?: ZipOptions,
    slow = false
): Promise<{ bytes: Buffer; error: unknown }> {
    const chunks: Buffer[] = [];
    const zip = new ZipWriter(async (chunk) => {
        if (slow) await new Promise((r) => setImmediate(r));
        chunks.push(Buffer.from(chunk));
    }, opts);
    let error: unknown = null;
    try {
        await fill(zip);
    } catch (e) {
        error = e;
    }
    await zip.finish();
    return { bytes: Buffer.concat(chunks), error };
}

async function* pieces(...parts: string[]): AsyncGenerator<Uint8Array> {
    for (const part of parts) yield Buffer.from(part);
}

describe('l’archive zip', () => {
    it('garde chaque entrée intacte, compressée ou stockée, avec des noms UTF-8', async () => {
        const { bytes } = await build(async (zip) => {
            await zip.add('Compte/compte.json', Buffer.from('{"a":1}'));
            await zip.add('Espaces/Équipe/notes.json', pieces('[', '"é"', ']'));
            await zip.add('image.png', Buffer.from([1, 2, 3, 4]), { compress: false });
            await zip.add('vide.txt', Buffer.alloc(0));
        });
        const read = readZip(bytes);
        assert.deepEqual(
            read.map((r) => [r.name, r.data.toString('utf8'), r.method, r.flags & 0x0808]),
            [
                ['Compte/compte.json', '{"a":1}', 8, 0x0808],
                ['Espaces/Équipe/notes.json', '["é"]', 8, 0x0808],
                ['image.png', '\u0001\u0002\u0003\u0004', 0, 0x0808],
                ['vide.txt', '', 8, 0x0808]
            ]
        );
    });

    it('passe en ZIP64 au-delà du seuil, pour les tailles, les positions et le nombre d’entrées', async () => {
        const big = Buffer.alloc(5000, 7);
        const { bytes } = await build(
            async (zip) => {
                for (let i = 0; i < 6; i++) await zip.add(`f${i}.bin`, big, { compress: i % 2 === 0 });
            },
            { zip64At: 1000, zip64Entries: 4 }
        );
        const read = readZip(bytes);
        assert.equal(read.length, 6);
        assert.ok(read.every((r) => r.data.equals(big)));
        assert.ok(bytes.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06])), 'fin d’archive ZIP64');
    });

    it('referme proprement une entrée dont la source échoue, et le dit', async () => {
        async function* failing(): AsyncGenerator<Uint8Array> {
            yield Buffer.from('début');
            throw new Error('source perdue');
        }
        const { bytes, error } = await build(async (zip) => {
            await zip.add('a.txt', Buffer.from('ok'));
            await zip.add('b.txt', failing());
        });
        assert.match(String(error), /source perdue/);
        assert.deepEqual(
            readZip(bytes).map((r) => [r.name, r.data.toString()]),
            [
                ['a.txt', 'ok'],
                ['b.txt', 'début']
            ]
        );
    });

    it('attend le consommateur au lieu de lire la source d’avance', async () => {
        let pulled = 0;
        async function* counted(): AsyncGenerator<Uint8Array> {
            for (let i = 0; i < 50; i++) {
                pulled++;
                yield Buffer.alloc(64 * 1024, i);
            }
        }
        const { bytes } = await build(async (zip) => zip.add('gros.bin', counted(), { compress: false }), {}, true);
        assert.equal(pulled, 50);
        assert.equal(readZip(bytes)[0].data.length, 50 * 64 * 1024);
    });

    it('se lit avec les outils du système quand ils sont là', async (t) => {
        const unzip = spawnSync('unzip', ['-v'], { encoding: 'utf8' });
        if (unzip.status !== 0) return t.skip('unzip absent');
        const dir = mkdtempSync(path.join(tmpdir(), 'zip-test-'));
        try {
            const { bytes } = await build(
                async (zip) => {
                    await zip.add('Espaces/Équipe/a.json', Buffer.from('{}'));
                    for (let i = 0; i < 5; i++) await zip.add(`n${i}.txt`, Buffer.alloc(3000, 65));
                },
                { zip64At: 1000, zip64Entries: 3 }
            );
            const file = path.join(dir, 'x.zip');
            writeFileSync(file, bytes);
            const test = spawnSync('unzip', ['-t', file], { encoding: 'utf8' });
            assert.equal(test.status, 0, test.stdout + test.stderr);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
