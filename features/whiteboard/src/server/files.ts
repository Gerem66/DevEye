import { createHash } from 'node:crypto';

import { MODERATION_PROVIDER, type ModerationProvider } from '@deveye/types/sdk';
import { FeatureError, openSealedStream, sealStream, type SdkProviders } from '@deveye/types/sdk/server';

import { FILE_MAX_BYTES, FILES_BATCH_CHARS, type BoardFile, type WhiteboardFileMime } from '../contracts/domain';
import { newObjectKey, now, whiteboard } from './_shared';
import type { BoardRow, FileRow, WhiteboardRepo } from './repo';

const EXTENSION: Record<WhiteboardFileMime, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/svg+xml': 'svg'
};

/** Le base64 d'une data URL, strict : un octet de trop ou de travers refuse tout. */
export function decodeDataUrl(dataURL: string, mime: WhiteboardFileMime): Buffer {
    const prefix = `data:${mime};base64,`;
    if (!dataURL.startsWith(prefix))
        throw new FeatureError('validation', 'Image illisible : son type ne correspond pas.');
    const b64 = dataURL.slice(prefix.length);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 !== 0) {
        throw new FeatureError('validation', 'Image illisible.');
    }
    if ((b64.length / 4) * 3 > FILE_MAX_BYTES + 3) {
        throw new FeatureError('validation', 'Image trop lourde : 4 Mo au plus.');
    }
    const bytes = Buffer.from(b64, 'base64');
    if (bytes.length === 0 || bytes.length > FILE_MAX_BYTES) {
        throw new FeatureError('validation', 'Image trop lourde : 4 Mo au plus.');
    }
    return bytes;
}

/** Les premiers octets disent le format : le type annoncé par le navigateur ne suffit pas. */
export function looksLike(bytes: Buffer, mime: WhiteboardFileMime): boolean {
    const starts = (sig: number[], at = 0) => sig.every((b, i) => bytes[at + i] === b);
    switch (mime) {
        case 'image/png':
            return starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        case 'image/jpeg':
            return starts([0xff, 0xd8, 0xff]);
        case 'image/gif':
            return (
                bytes.subarray(0, 6).toString('latin1') === 'GIF87a' ||
                bytes.subarray(0, 6).toString('latin1') === 'GIF89a'
            );
        case 'image/webp':
            return (
                bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
                bytes.subarray(8, 12).toString('latin1') === 'WEBP'
            );
        case 'image/svg+xml':
            // Rendu par Excalidraw dans une balise <img> : aucun script ne s'y exécute.
            return /<svg[\s>]/i.test(bytes.subarray(0, 4096).toString('utf8'));
    }
}

async function* once(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
    yield bytes;
}

async function collect(source: AsyncIterable<Buffer>): Promise<Buffer> {
    const parts: Buffer[] = [];
    for await (const part of source) parts.push(part);
    return Buffer.concat(parts);
}

/** Les octets d'une image, ouverts. Lève si l'objet manque ou ne s'authentifie pas. */
export async function readFileBytes(objectKey: string): Promise<Buffer> {
    const { objects, keys } = whiteboard();
    return collect(openSealedStream(keys.files, objects.get(objectKey)));
}

/** Une copie d'objet telle quelle, sous une nouvelle clé : le scellé ne dépend pas du chemin. */
export async function copyObject(from: string): Promise<string> {
    const { objects } = whiteboard();
    const to = newObjectKey();
    await objects.put(to, objects.get(from));
    return to;
}

export interface FileAddInput {
    repo: WhiteboardRepo;
    providers: SdkProviders;
    board: BoardRow;
    title: string;
    userId: number;
    fileId: string;
    mime: WhiteboardFileMime;
    dataURL: string;
}

/**
 * Une image arrive : vérifiée, comptée chez le propriétaire de l'espace
 * d'origine du tableau, soumise à la modération si elle est installée, puis
 * scellée dans le magasin. La ligne précède l'objet : un objet sans ligne serait
 * invisible au quota jusqu'au balayage.
 */
export async function addFile(input: FileAddInput): Promise<{ created: boolean }> {
    const { repo, board } = input;
    const existing = await repo.files.find(board.id, input.fileId);
    if (existing !== null) {
        if (existing.orphaned_at !== null) await repo.files.reconcileOrphans(board.id, [input.fileId], now());
        return { created: false };
    }

    const runtime = whiteboard();
    const problem = await runtime.storageProblem();
    if (problem !== null) throw new FeatureError('internal', problem);

    const bytes = decodeDataUrl(input.dataURL, input.mime);
    if (!looksLike(bytes, input.mime)) throw new FeatureError('validation', 'Ce fichier n’est pas l’image annoncée.');

    await runtime
        .quotaFor(board.workspace_id)
        .assert('storage', async (owned) => (await repo.boards.storedBytesIn(owned)) + bytes.length);

    const moderation = input.providers.get<ModerationProvider>(MODERATION_PROVIDER);
    if (moderation) {
        const hit = await moderation.check({
            sha256: createHash('sha256').update(bytes).digest('hex'),
            name: `${input.fileId}.${EXTENSION[input.mime]}`,
            exposure: 'private',
            origin: {
                feature: 'whiteboard',
                workspaceId: board.workspace_id,
                userId: input.userId,
                context: input.title
            },
            size: bytes.length
        });
        if (hit) throw new FeatureError('forbidden', `Image refusée : ${hit.label}.`);
    }

    const objectKey = newObjectKey();
    let rowId: number;
    try {
        rowId = await repo.files.insert({
            boardId: board.id,
            fileId: input.fileId,
            mime: input.mime,
            bytes: bytes.length,
            objectKey,
            at: now()
        });
    } catch (error) {
        // Deux onglets envoient la même image au même instant : l'autre a gagné.
        if ((error as { code?: string }).code === 'ER_DUP_ENTRY') return { created: false };
        throw error;
    }
    try {
        await runtime.objects.put(objectKey, sealStream(runtime.keys.files, once(bytes)));
    } catch (error) {
        await repo.files.deleteRow(rowId);
        throw error;
    }
    return { created: true };
}

/** Des images d'un tableau, dans le budget d'une réponse ; au moins une quoi qu'il arrive. */
export async function readFiles(
    rows: readonly FileRow[],
    wanted: readonly string[]
): Promise<{ files: BoardFile[]; missing: string[]; more: string[] }> {
    const byId = new Map(rows.map((row) => [row.file_id, row]));
    const files: BoardFile[] = [];
    const missing: string[] = [];
    const more: string[] = [];
    let chars = 0;
    for (const fileId of new Set(wanted)) {
        const row = byId.get(fileId);
        if (!row) {
            missing.push(fileId);
            continue;
        }
        if (files.length > 0 && chars >= FILES_BATCH_CHARS) {
            more.push(fileId);
            continue;
        }
        try {
            const bytes = await readFileBytes(row.object_key);
            const dataURL = `data:${row.mime};base64,${bytes.toString('base64')}`;
            chars += dataURL.length;
            files.push({
                id: row.file_id,
                mimeType: row.mime as WhiteboardFileMime,
                dataURL,
                created: Number(row.created) * 1000
            });
        } catch {
            missing.push(fileId);
        }
    }
    return { files, missing, more };
}
