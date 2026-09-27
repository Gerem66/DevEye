import { once } from 'node:events';
import zlib from 'node:zlib';

/**
 * Une archive zip écrite au fil de l'eau, entrée après entrée, sans jamais
 * connaître d'avance la taille de ce qu'elle reçoit : chaque entrée porte un
 * descripteur après ses données (bit 3), et ZIP64 prend le relais au-delà de
 * 4 Gio ou de 65 535 entrées. Seul le répertoire central reste en mémoire,
 * une centaine d'octets par entrée.
 */

const LOCAL = 0x04034b50;
const DESCRIPTOR = 0x08074b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const END64 = 0x06064b50;
const LOCATOR64 = 0x07064b50;

const FLAGS = 0x0008 | 0x0800;
const MAX32 = 0xffffffff;
const MAX16 = 0xffff;
/** `-rw-r--r--`, dit par un créateur Unix : sans lui, certains outils extraient des fichiers sans droit de lecture. */
const EXTERNAL_ATTRS = (0o100644 << 16) >>> 0;
const MADE_BY = (3 << 8) | 45;

interface CentralEntry {
    name: Buffer;
    method: number;
    time: number;
    date: number;
    crc: number;
    compressed: number;
    size: number;
    offset: number;
}

export interface ZipOptions {
    /** À partir de quelle taille ou position les champs passent en 64 bits. Abaissé par les tests. */
    zip64At?: number;
    /** À partir de combien d'entrées la fin d'archive passe en 64 bits. Abaissé par les tests. */
    zip64Entries?: number;
}

function dosTime(seconds: number): { time: number; date: number } {
    const d = new Date(seconds * 1000);
    const year = Math.max(1980, d.getFullYear());
    return {
        time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
        date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
    };
}

async function* chunksOf(source: Uint8Array | AsyncIterable<Uint8Array>): AsyncGenerator<Buffer> {
    if (source instanceof Uint8Array) {
        yield Buffer.from(source.buffer, source.byteOffset, source.byteLength);
        return;
    }
    for await (const chunk of source) yield Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
}

export class ZipWriter {
    private offset = 0;
    private readonly entries: CentralEntry[] = [];
    private readonly zip64At: number;
    private readonly zip64Entries: number;

    /** `write` doit attendre que l'octet soit parti (le drain de la réponse) : c'est lui qui tient la contre-pression. */
    constructor(
        private readonly write: (chunk: Buffer) => Promise<void>,
        opts: ZipOptions = {}
    ) {
        this.zip64At = opts.zip64At ?? MAX32;
        this.zip64Entries = opts.zip64Entries ?? MAX16;
    }

    private async emit(chunk: Buffer): Promise<void> {
        if (chunk.length === 0) return;
        this.offset += chunk.length;
        await this.write(chunk);
    }

    /**
     * Ajoute une entrée. Si la source échoue en route, l'entrée est refermée
     * sur ce qui est passé (l'archive reste lisible), puis l'erreur remonte.
     */
    async add(
        name: string,
        source: Uint8Array | AsyncIterable<Uint8Array>,
        opts: { mtime?: number; compress?: boolean } = {}
    ): Promise<void> {
        const encoded = Buffer.from(name, 'utf8');
        const method = opts.compress === false ? 0 : 8;
        const { time, date } = dosTime(opts.mtime ?? Math.floor(Date.now() / 1000));
        const offset = this.offset;

        const header = Buffer.alloc(30);
        header.writeUInt32LE(LOCAL, 0);
        header.writeUInt16LE(45, 4);
        header.writeUInt16LE(FLAGS, 6);
        header.writeUInt16LE(method, 8);
        header.writeUInt16LE(time, 10);
        header.writeUInt16LE(date, 12);
        header.writeUInt16LE(encoded.length, 26);
        await this.emit(Buffer.concat([header, encoded]));

        let crc = 0;
        let size = 0;
        let compressed = 0;
        let failure: unknown = null;
        try {
            if (method === 0) {
                for await (const chunk of chunksOf(source)) {
                    crc = zlib.crc32(chunk, crc);
                    size += chunk.length;
                    compressed += chunk.length;
                    await this.emit(chunk);
                }
            } else {
                const deflate = zlib.createDeflateRaw({ level: 6 });
                const drained = (async () => {
                    for await (const out of deflate as AsyncIterable<Buffer>) {
                        compressed += out.length;
                        await this.emit(out);
                    }
                })();
                try {
                    for await (const chunk of chunksOf(source)) {
                        crc = zlib.crc32(chunk, crc);
                        size += chunk.length;
                        if (!deflate.write(chunk)) await once(deflate, 'drain');
                    }
                } catch (e) {
                    failure = e;
                }
                deflate.end();
                await drained;
            }
        } catch (e) {
            failure = e;
        }

        const wide = size >= this.zip64At || compressed >= this.zip64At;
        const descriptor = Buffer.alloc(wide ? 24 : 16);
        descriptor.writeUInt32LE(DESCRIPTOR, 0);
        descriptor.writeUInt32LE(crc >>> 0, 4);
        if (wide) {
            descriptor.writeBigUInt64LE(BigInt(compressed), 8);
            descriptor.writeBigUInt64LE(BigInt(size), 16);
        } else {
            descriptor.writeUInt32LE(compressed, 8);
            descriptor.writeUInt32LE(size, 12);
        }
        await this.emit(descriptor);
        this.entries.push({ name: encoded, method, time, date, crc: crc >>> 0, compressed, size, offset });
        if (failure !== null) throw failure;
    }

    /** Le répertoire central et la fin d'archive. Rien ne s'ajoute après. */
    async finish(): Promise<void> {
        const start = this.offset;
        for (const entry of this.entries) {
            const big = [entry.size, entry.compressed, entry.offset].map((n) => n >= this.zip64At);
            const extra: Buffer[] = [];
            if (big[0]) extra.push(u64(entry.size));
            if (big[1]) extra.push(u64(entry.compressed));
            if (big[2]) extra.push(u64(entry.offset));
            const extraField =
                extra.length === 0 ? Buffer.alloc(0) : Buffer.concat([u16(0x0001), u16(extra.length * 8), ...extra]);
            const record = Buffer.alloc(46);
            record.writeUInt32LE(CENTRAL, 0);
            record.writeUInt16LE(MADE_BY, 4);
            record.writeUInt16LE(extra.length > 0 ? 45 : 20, 6);
            record.writeUInt16LE(FLAGS, 8);
            record.writeUInt16LE(entry.method, 10);
            record.writeUInt16LE(entry.time, 12);
            record.writeUInt16LE(entry.date, 14);
            record.writeUInt32LE(entry.crc, 16);
            record.writeUInt32LE(big[1] ? MAX32 : entry.compressed, 20);
            record.writeUInt32LE(big[0] ? MAX32 : entry.size, 24);
            record.writeUInt16LE(entry.name.length, 28);
            record.writeUInt16LE(extraField.length, 30);
            record.writeUInt32LE(EXTERNAL_ATTRS, 38);
            record.writeUInt32LE(big[2] ? MAX32 : entry.offset, 42);
            await this.emit(Buffer.concat([record, entry.name, extraField]));
        }
        const size = this.offset - start;
        const count = this.entries.length;
        const wide = count >= this.zip64Entries || start >= this.zip64At || size >= this.zip64At;
        if (wide) {
            const end64At = this.offset;
            const end64 = Buffer.alloc(56);
            end64.writeUInt32LE(END64, 0);
            end64.writeBigUInt64LE(44n, 4);
            end64.writeUInt16LE(MADE_BY, 12);
            end64.writeUInt16LE(45, 14);
            end64.writeBigUInt64LE(BigInt(count), 24);
            end64.writeBigUInt64LE(BigInt(count), 32);
            end64.writeBigUInt64LE(BigInt(size), 40);
            end64.writeBigUInt64LE(BigInt(start), 48);
            const locator = Buffer.alloc(20);
            locator.writeUInt32LE(LOCATOR64, 0);
            locator.writeBigUInt64LE(BigInt(end64At), 8);
            locator.writeUInt32LE(1, 16);
            await this.emit(Buffer.concat([end64, locator]));
        }
        const end = Buffer.alloc(22);
        end.writeUInt32LE(END, 0);
        end.writeUInt16LE(wide ? MAX16 : count, 8);
        end.writeUInt16LE(wide ? MAX16 : count, 10);
        end.writeUInt32LE(wide ? MAX32 : size, 12);
        end.writeUInt32LE(wide ? MAX32 : start, 16);
        await this.emit(end);
    }
}

function u16(n: number): Buffer {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(n, 0);
    return b;
}

function u64(n: number): Buffer {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(n), 0);
    return b;
}
