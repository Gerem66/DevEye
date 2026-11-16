import { promisify } from 'node:util';
import { gunzip as gunzipCb, inflateRaw as inflateRawCb } from 'node:zlib';

/**
 * Les archives des stores, lues sans dépendance : le `.gz` d'un rapport
 * d'Apple, le `.zip` à une seule entrée d'un rapport de ventes de Google Play.
 * La décompression est asynchrone et bornée (`maxOutputLength`) : une archive
 * démesurée ne bloque pas la boucle et ne remplit pas la mémoire.
 */

const gunzipAsync = promisify(gunzipCb);
const inflateRawAsync = promisify(inflateRawCb);

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
/** La fin du répertoire central tient en 22 octets, plus un commentaire de 64 Kio au plus. */
const EOCD_MIN = 22;
const EOCD_SEARCH = EOCD_MIN + 0xffff;

export class ArchiveError extends Error {
    constructor(message: string, cause?: unknown) {
        super(message);
        this.name = 'ArchiveError';
        if (cause !== undefined) this.cause = cause;
    }
}

function tooLarge(e: unknown): boolean {
    return e instanceof RangeError || (e as { code?: unknown }).code === 'ERR_BUFFER_TOO_LARGE';
}

export async function gunzip(bytes: Buffer, maxOutput: number): Promise<Buffer> {
    try {
        return await gunzipAsync(bytes, { maxOutputLength: maxOutput });
    } catch (e) {
        throw new ArchiveError(tooLarge(e) ? 'Archive trop volumineuse.' : 'Archive illisible.', e);
    }
}

/** La première entrée d'un `.zip` qui ne soit pas un dossier : son nom et ses octets. */
export async function unzipFirst(bytes: Buffer, maxOutput: number): Promise<{ name: string; data: Buffer }> {
    let eocd = -1;
    for (let at = bytes.length - EOCD_MIN; at >= Math.max(0, bytes.length - EOCD_SEARCH); at--) {
        if (bytes.readUInt32LE(at) === EOCD_SIGNATURE) {
            eocd = at;
            break;
        }
    }
    if (eocd < 0) throw new ArchiveError('Archive zip illisible : fin de répertoire introuvable.');
    const entries = bytes.readUInt16LE(eocd + 10);
    let at = bytes.readUInt32LE(eocd + 16);

    for (let i = 0; i < entries; i++) {
        if (at + 46 > bytes.length || bytes.readUInt32LE(at) !== CENTRAL_SIGNATURE) {
            throw new ArchiveError('Archive zip illisible : répertoire central abîmé.');
        }
        const method = bytes.readUInt16LE(at + 10);
        const compressed = bytes.readUInt32LE(at + 20);
        const size = bytes.readUInt32LE(at + 24);
        const nameLength = bytes.readUInt16LE(at + 28);
        const extraLength = bytes.readUInt16LE(at + 30);
        const commentLength = bytes.readUInt16LE(at + 32);
        const local = bytes.readUInt32LE(at + 42);
        const name = bytes.toString('utf8', at + 46, at + 46 + nameLength);
        at += 46 + nameLength + extraLength + commentLength;
        if (name.endsWith('/')) continue;

        if (compressed === 0xffffffff || size === 0xffffffff || local === 0xffffffff) {
            throw new ArchiveError('Archive zip64 non prise en charge.');
        }
        if (size > maxOutput) throw new ArchiveError('Archive trop volumineuse.');
        if (local + 30 > bytes.length || bytes.readUInt32LE(local) !== LOCAL_SIGNATURE) {
            throw new ArchiveError('Archive zip illisible : en-tête local abîmé.');
        }
        // Les tailles viennent du répertoire central : l'en-tête local peut les
        // laisser à zéro quand un descripteur suit les données.
        const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
        if (start + compressed > bytes.length) throw new ArchiveError('Archive zip tronquée.');
        const raw = bytes.subarray(start, start + compressed);
        if (method === 0) return { name, data: Buffer.from(raw) };
        if (method !== 8) throw new ArchiveError(`Méthode de compression ${method} non prise en charge.`);
        try {
            return { name, data: await inflateRawAsync(raw, { maxOutputLength: maxOutput }) };
        } catch (e) {
            throw new ArchiveError(tooLarge(e) ? 'Archive trop volumineuse.' : 'Archive zip illisible.', e);
        }
    }
    throw new ArchiveError('Archive zip vide.');
}
