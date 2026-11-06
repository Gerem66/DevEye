import type { FeatureAccountExport } from '@deveye/types/sdk/server';

import type { BoardAppearance } from '../contracts/domain';
import { appearanceOf, openScene, openTitle, untitled } from './_shared';
import { readFileBytes } from './files';
import type { FileRow, WhiteboardRepo } from './repo';

const encoder = new TextEncoder();

/** Un nom de fichier sans ce qu'un système refuserait. */
function safeName(title: string): string {
    return untitled(title)
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
        .slice(0, 120);
}

/**
 * Un `.excalidraw` que l'application d'origine rouvre telle quelle : la scène,
 * puis chaque image en data URL, écrites l'une après l'autre plutôt qu'en un
 * seul bloc en mémoire.
 */
async function* excalidrawFile(
    elementsJson: string,
    appearance: BoardAppearance,
    files: readonly FileRow[],
    withImages: boolean,
    signal: AbortSignal
): AsyncGenerator<Uint8Array> {
    const appState = {
        ...(appearance.background !== null ? { viewBackgroundColor: appearance.background } : {}),
        ...(appearance.theme !== null ? { theme: appearance.theme } : {})
    };
    yield encoder.encode(
        `{"type":"excalidraw","version":2,"source":"DevEye","elements":${elementsJson},"appState":${JSON.stringify(appState)},"files":{`
    );
    let first = true;
    for (const file of withImages ? files : []) {
        if (signal.aborted) return;
        const bytes = await readFileBytes(file.object_key);
        const entry = JSON.stringify({
            mimeType: file.mime,
            id: file.file_id,
            dataURL: `data:${file.mime};base64,${bytes.toString('base64')}`,
            created: Number(file.created) * 1000
        });
        yield encoder.encode(`${first ? '' : ','}${JSON.stringify(file.file_id)}:${entry}`);
        first = false;
    }
    yield encoder.encode('}}');
}

/**
 * Chaque tableau devient un `<titre>.excalidraw` réouvrable, images comprises
 * quand le titulaire les garde, plus `tableaux.json` qui les liste. La clé du
 * module ne sort jamais : les images partent déchiffrées.
 */
export const whiteboardAccountExport: FeatureAccountExport<WhiteboardRepo> = {
    tables: {
        ft_whiteboard_boards: 'custom',
        ft_whiteboard_files: 'custom',
        ft_whiteboard_key: { skip: 'La clé qui chiffre les images des tableaux sur le serveur ne sort jamais.' }
    },
    files: {
        images: {
            label: 'les images des tableaux blancs',
            optional: true,
            async bytes({ q, workspaceIds }) {
                if (workspaceIds.length === 0) return 0;
                const rows = await q.query<{ n: number | null }>(
                    `SELECT COALESCE(SUM(f.bytes), 0) AS n FROM ft_whiteboard_files f
                       JOIN ft_whiteboard_boards b ON b.id = f.board_id
                      WHERE b.workspace_id IN (?) AND f.orphaned_at IS NULL`,
                    [[...workspaceIds]]
                );
                return Number(rows[0]?.n ?? 0);
            }
        }
    },
    async workspace(ctx) {
        const boards = await ctx.q.query<{
            id: number;
            content: string;
            scene: string;
            background: string | null;
            theme: string | null;
            created: number;
            updated: number;
        }>(
            'SELECT id, content, scene, background, theme, created, updated FROM ft_whiteboard_boards WHERE workspace_id = ? ORDER BY id',
            [ctx.workspace.id]
        );
        if (boards.length === 0) return;
        const cipher = ctx.cipher();
        const withImages = ctx.includes('images');
        const titles = await Promise.all(boards.map(async (b) => safeName(await openTitle(cipher, b.content))));
        const counts = new Map<string, number>();
        for (const title of titles) counts.set(title, (counts.get(title) ?? 0) + 1);

        const index: { id: number; title: string; file: string; created: string; updated: string }[] = [];
        let unreadable = 0;
        for (const [i, board] of boards.entries()) {
            if (ctx.signal.aborted) return;
            const base = titles[i];
            // Deux tableaux du même nom ne s'écrasent pas : l'id les départage.
            const file = `${(counts.get(base) ?? 0) > 1 ? `${base} (${board.id})` : base}.excalidraw`;
            const elements = await openScene(cipher, board.scene);
            if (elements === null) {
                unreadable++;
                continue;
            }
            const files = (await ctx.repo.files.listOf(board.id)).filter((f) => f.orphaned_at === null);
            try {
                await ctx.out.file(
                    file,
                    excalidrawFile(JSON.stringify(elements), appearanceOf(board), files, withImages, ctx.signal),
                    {
                        mtime: Number(board.updated)
                    }
                );
            } catch (error) {
                if (ctx.signal.aborted) throw error;
                unreadable++;
                continue;
            }
            index.push({
                id: board.id,
                title: untitled(await openTitle(cipher, board.content)),
                file,
                created: new Date(Number(board.created) * 1000).toISOString(),
                updated: new Date(Number(board.updated) * 1000).toISOString()
            });
        }
        await ctx.out.json('tableaux.json', index);
        if (unreadable > 0) throw new Error(`${unreadable} tableau(x) blanc(s) illisible(s)`);
    }
};
