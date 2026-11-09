import { promisify } from 'node:util';
import { inflateRaw } from 'node:zlib';

import { FeatureError, type FeatureItemsCopy, type ItemTree, type ItemTreeRow } from '@deveye/types/sdk/server';
import { z } from 'zod';

import {
    FILE_MAX_BYTES,
    fileIdSchema,
    fileMimeSchema,
    PREVIEW_MAX_CHARS,
    SCENE_MAX_BYTES,
    sceneElementSchema
} from '../contracts/domain';
import { appearanceOf, OBJECT_KEY_PATTERN, whiteboard } from './_shared';
import { copyObject } from './files';
import type { WhiteboardRepo } from './repo';

const unzip = promisify(inflateRaw);

/**
 * Ce dont un tableau est fait : sa ligne, avec ses trois blobs, et ses images.
 * Les octets des images restent dans le magasin, scellés par la clé du module :
 * la copie en duplique les objets, le déplacement n'y touche pas.
 *
 * ⚠️ À tenir à jour : toute nouvelle colonne chiffrée doit figurer dans `sealed`,
 * sinon un déplacement la laisse sous l'ancienne clé, où elle devient illisible.
 */
export const whiteboardTree: ItemTree = [
    {
        table: 'ft_whiteboard_boards',
        idColumn: 'id',
        ownerColumn: 'id',
        workspaceColumn: 'workspace_id',
        userColumn: 'user_id',
        sealed: ['content', 'scene', 'preview'],
        omit: ['updated_by', 'version', 'preview_version', 'created', 'updated']
    },
    {
        table: 'ft_whiteboard_files',
        idColumn: 'id',
        ownerColumn: 'board_id',
        refs: { board_id: 'ft_whiteboard_boards' }
    }
];

/** Au-delà, la copie passe par l'export : la transaction de la destination tiendrait trop longtemps. */
const COPY_MAX_IMAGE_BYTES = 256 * 1024 * 1024;

const ELSEWHERE =
    'Les images de ce tableau sont restées sur son serveur d’origine : exportez-le en .excalidraw depuis le tableau, puis importez-le ici.';

const fileRowSchema = z.looseObject({
    file_id: fileIdSchema,
    mime: fileMimeSchema,
    bytes: z.coerce.number().int().positive().max(FILE_MAX_BYTES),
    object_key: z.string().regex(OBJECT_KEY_PATTERN),
    orphaned_at: z.unknown().optional()
});

/** La scène telle que la copie la porte : la charge compressée, en clair. */
async function sceneBytesOf(raw: unknown): Promise<number> {
    if (typeof raw !== 'string' || !raw.startsWith('z1:'))
        throw new FeatureError('validation', 'Scène illisible dans la copie.');
    const json = (await unzip(Buffer.from(raw.slice(3), 'base64'))).toString('utf8');
    const bytes = Buffer.byteLength(json, 'utf8');
    if (bytes > SCENE_MAX_BYTES) throw new FeatureError('validation', 'Ce dessin est trop volumineux pour être copié.');
    const parsed = z.object({ elements: z.array(sceneElementSchema) }).safeParse(JSON.parse(json));
    if (!parsed.success) throw new FeatureError('validation', 'Scène illisible dans la copie.');
    return bytes;
}

export const whiteboardCopy: FeatureItemsCopy<WhiteboardRepo> = {
    tree: whiteboardTree,

    async plan({ repo, itemId }) {
        const boardId = Number(itemId);
        // La base doit porter ce que la séance tient : la copie lit les lignes.
        await whiteboard().sessions.flushNow(boardId);
        const files = await repo.files.listOf(boardId);
        const imageBytes = files.filter((f) => f.orphaned_at === null).reduce((n, f) => n + Number(f.bytes), 0);
        return {
            blockers:
                imageBytes > COPY_MAX_IMAGE_BYTES
                    ? [
                          'Ce tableau porte trop d’images pour être copié d’un geste : exportez-le en .excalidraw, puis importez-le.'
                      ]
                    : [],
            drops: []
        };
    },

    async admit({ repo, rows, quota }) {
        const board = rows.ft_whiteboard_boards?.[0];
        if (!board) throw new FeatureError('validation', 'La copie doit porter exactement un tableau.');
        board.scene_bytes = await sceneBytesOf(board.scene);
        Object.assign(board, appearanceOf({ background: board.background, theme: board.theme }));
        const preview = board.preview;
        if (preview !== null && preview !== undefined && preview !== '') {
            if (
                typeof preview !== 'string' ||
                preview.length > PREVIEW_MAX_CHARS ||
                !preview.startsWith('data:image/')
            ) {
                board.preview = null;
                board.preview_bytes = 0;
            } else board.preview_bytes = preview.length;
        } else board.preview_bytes = 0;

        // Les images que la scène ne montre plus ne voyagent pas. Le scellé ne
        // dépend pas du chemin : l'objet se recopie tel quel, et sa présence
        // ici prouve que la copie part de ce serveur.
        const { objects } = whiteboard();
        const files: ItemTreeRow[] = [];
        let imageBytes = 0;
        for (const raw of rows.ft_whiteboard_files ?? []) {
            const parsed = fileRowSchema.safeParse(raw);
            if (!parsed.success) throw new FeatureError('validation', 'Image illisible dans la copie.');
            if (parsed.data.orphaned_at !== null && parsed.data.orphaned_at !== undefined) continue;
            if ((await objects.head(parsed.data.object_key)) === null) throw new FeatureError('conflict', ELSEWHERE);
            imageBytes += Number(parsed.data.bytes);
            files.push(raw);
        }

        const total = Number(board.scene_bytes) + Number(board.preview_bytes) + imageBytes;
        await quota.assert('storage', async (owned) => (await repo.boards.storedBytesIn(owned)) + total);

        // Une transaction annulée après ce point laisse des objets sans ligne : le balayage les reprend.
        for (const raw of files) {
            raw.object_key = await copyObject(String(raw.object_key));
            raw.orphaned_at = null;
        }
        rows.ft_whiteboard_files = files;
    }
};
