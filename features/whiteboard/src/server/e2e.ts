import { randomUUID } from 'node:crypto';

import type { FeatureE2eEntry, SdkE2eContext } from '@deveye/types/sdk/server';

import type { BoardSummary, SceneElement } from '../contracts/domain';
import { openScene, whiteboard } from './_shared';
import type { WhiteboardRepo } from './repo';

type Ctx = SdkE2eContext<WhiteboardRepo>;

/** Un pixel PNG, transparent. */
const PIXEL =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const FILE_ID = 'e2e0000000000000000000000000000000000001';

function element(id: string, over: Partial<SceneElement> = {}): SceneElement {
    return {
        id,
        type: 'rectangle',
        version: 1,
        versionNonce: 1000,
        isDeleted: false,
        index: 'a0',
        updated: Date.now(),
        x: 0,
        y: 0,
        width: 100,
        height: 60,
        ...over
    };
}

const boardOf = (ctx: Ctx) => ctx.state.get('board') as BoardSummary;

async function addBoard(ctx: Ctx, title: string, elements: SceneElement[]): Promise<BoardSummary> {
    const { board } = await ctx.send<{ board: BoardSummary }>('whiteboard.add', { title, elements });
    ctx.defer(`Supprimer « ${title} »`, async () => {
        try {
            await ctx.send('whiteboard.remove', { boardId: board.id });
        } catch (e) {
            if ((e as { code?: string }).code !== 'not_found') throw e;
        }
    });
    return board;
}

async function storedElements(ctx: Ctx, boardId: number): Promise<SceneElement[]> {
    const row = await ctx.repo.boards.loadScene(boardId);
    if (row === null) throw new Error('Tableau introuvable en base');
    const elements = await openScene(whiteboard().cipherFor(row.workspace_id), row.scene);
    if (elements === null) throw new Error('Scène illisible en base');
    return elements;
}

/**
 * Un tableau de bout en bout : création, image, aperçu, chiffrement au repos et
 * suppression ; une séance à deux onglets ; puis le partage, la copie et le
 * déplacement vers un autre espace.
 */
export const whiteboardE2e: FeatureE2eEntry<WhiteboardRepo> = {
    scenarios: [
        {
            id: 'lifecycle',
            label: 'Créer un tableau, y coller une image, le supprimer',
            steps: [
                {
                    label: 'Créer un tableau qui montre une image',
                    run: async (ctx) => {
                        const board = await addBoard(ctx, 'Essai de bout en bout', [
                            element('e2e-rect'),
                            element('e2e-image', { type: 'image', fileId: FILE_ID, index: 'a1' })
                        ]);
                        ctx.state.set('board', board);
                        return `Tableau ${board.id}`;
                    }
                },
                {
                    label: 'Envoyer l’image, deux fois',
                    run: async (ctx) => {
                        const input = {
                            boardId: boardOf(ctx).id,
                            fileId: FILE_ID,
                            mimeType: 'image/png',
                            dataURL: PIXEL
                        };
                        const first = await ctx.send<{ created: boolean }>('whiteboard.fileAdd', input);
                        const again = await ctx.send<{ created: boolean }>('whiteboard.fileAdd', input);
                        if (!first.created || again.created) throw new Error('Le second envoi aurait dû être reconnu');
                    }
                },
                {
                    label: 'Refuser un fichier qui n’est pas l’image annoncée',
                    run: async (ctx) => {
                        try {
                            await ctx.send('whiteboard.fileAdd', {
                                boardId: boardOf(ctx).id,
                                fileId: 'e2e-fake',
                                mimeType: 'image/png',
                                dataURL: `data:image/png;base64,${Buffer.from('pas une image').toString('base64')}`
                            });
                        } catch (e) {
                            if ((e as { code?: string }).code === 'validation') return;
                            throw e;
                        }
                        throw new Error('Le faux PNG a été accepté');
                    }
                },
                {
                    label: 'Relire l’image, scellée au repos',
                    run: async (ctx) => {
                        const { files } = await ctx.send<{ files: { dataURL: string }[] }>('whiteboard.files', {
                            boardId: boardOf(ctx).id,
                            fileIds: [FILE_ID]
                        });
                        if (files[0]?.dataURL !== PIXEL) throw new Error('L’image relue diffère de l’envoyée');
                        const row = await ctx.repo.files.find(boardOf(ctx).id, FILE_ID);
                        if (row === null) throw new Error('Ligne de l’image absente');
                        let head = Buffer.alloc(0);
                        for await (const part of whiteboard().objects.get(row.object_key)) {
                            head = Buffer.concat([head, part]);
                            break;
                        }
                        if (head.subarray(0, 4).toString('latin1') !== 'DEVB')
                            throw new Error('L’objet n’est pas scellé');
                        const scene = await ctx.repo.boards.loadScene(boardOf(ctx).id);
                        if (scene?.scene.includes('rectangle')) throw new Error('La scène est lisible en base');
                    }
                },
                {
                    label: 'Poser un aperçu et renommer',
                    run: async (ctx) => {
                        const boardId = boardOf(ctx).id;
                        await ctx.send('whiteboard.setPreview', { boardId, dataURL: PIXEL });
                        await ctx.send('whiteboard.rename', { boardId, title: 'Essai renommé' });
                        const { boards } = await ctx.send<{ boards: BoardSummary[] }>('whiteboard.list', {});
                        const mine = boards.find((b) => b.id === boardId);
                        if (!mine?.hasPreview || mine.title !== 'Essai renommé' || mine.byteSize <= 0) {
                            throw new Error('La liste ne montre pas l’aperçu, le titre ou la taille');
                        }
                        const { previews } = await ctx.send<{ previews: { dataURL: string }[] }>(
                            'whiteboard.previews',
                            {
                                boardIds: [boardId]
                            }
                        );
                        if (previews[0]?.dataURL !== PIXEL) throw new Error('Aperçu relu différent');
                    }
                },
                {
                    label: 'Supprimer : lignes et objets partis',
                    run: async (ctx) => {
                        const boardId = boardOf(ctx).id;
                        const keys = await ctx.repo.files.objectKeysOf(boardId);
                        await ctx.send('whiteboard.remove', { boardId });
                        if ((await ctx.repo.boards.findById(boardId)) !== null) throw new Error('Le tableau est resté');
                        for (const key of keys) {
                            if ((await whiteboard().objects.head(key)) !== null)
                                throw new Error('Une image est restée');
                        }
                    }
                }
            ]
        },
        {
            id: 'collab',
            label: 'Dessiner à deux sur le même tableau',
            steps: [
                {
                    label: 'Ouvrir le tableau dans deux onglets',
                    run: async (ctx) => {
                        const board = await addBoard(ctx, 'Essai à deux', []);
                        ctx.state.set('board', board);
                        const a = randomUUID();
                        const b = randomUUID();
                        ctx.state.set('a', a);
                        ctx.state.set('b', b);
                        await ctx.send('whiteboard.join', { boardId: board.id, clientId: a });
                        const joined = await ctx.send<{ peers: unknown[] }>('whiteboard.join', {
                            boardId: board.id,
                            clientId: b
                        });
                        if (joined.peers.length !== 2)
                            throw new Error(`${joined.peers.length} participant(s) au lieu de 2`);
                    }
                },
                {
                    label: 'Un trait du premier, vu par le second',
                    run: async (ctx) => {
                        const boardId = boardOf(ctx).id;
                        await ctx.send('whiteboard.push', {
                            boardId,
                            clientId: ctx.state.get('a'),
                            elements: [element('e2e-line', { version: 2, versionNonce: 500 })]
                        });
                        const joined = await ctx.send<{ elements: SceneElement[] }>('whiteboard.join', {
                            boardId,
                            clientId: ctx.state.get('b')
                        });
                        if (!joined.elements.some((el) => el.id === 'e2e-line'))
                            throw new Error('Le second ne voit pas le trait');
                    }
                },
                {
                    label: 'Deux versions égales : le plus petit nonce l’emporte',
                    run: async (ctx) => {
                        const boardId = boardOf(ctx).id;
                        const loser = await ctx.send<{ accepted: number }>('whiteboard.push', {
                            boardId,
                            clientId: ctx.state.get('b'),
                            elements: [element('e2e-line', { version: 2, versionNonce: 900 })]
                        });
                        const winner = await ctx.send<{ accepted: number }>('whiteboard.push', {
                            boardId,
                            clientId: ctx.state.get('b'),
                            elements: [element('e2e-line', { version: 2, versionNonce: 100 })]
                        });
                        if (loser.accepted !== 0 || winner.accepted !== 1)
                            throw new Error('La fusion ne suit pas la règle');
                    }
                },
                {
                    label: 'Le fond de l’un et le thème de l’autre, gardés tous deux',
                    run: async (ctx) => {
                        const boardId = boardOf(ctx).id;
                        await ctx.send('whiteboard.setAppearance', { boardId, background: '#fffce8' });
                        await ctx.send('whiteboard.setAppearance', { boardId, theme: 'dark' });
                        const joined = await ctx.send<{
                            appearance: { background: string | null; theme: string | null };
                        }>('whiteboard.join', { boardId, clientId: ctx.state.get('b') });
                        if (joined.appearance.background !== '#fffce8' || joined.appearance.theme !== 'dark')
                            throw new Error(`Apparence relue : ${JSON.stringify(joined.appearance)}`);
                        const { boards } = await ctx.send<{ boards: BoardSummary[] }>('whiteboard.list', {});
                        if (boards.find((b) => b.id === boardId)?.theme !== 'dark')
                            throw new Error('La liste ne porte pas le thème du tableau');
                    }
                },
                {
                    label: 'Quitter : la scène est écrite',
                    run: async (ctx) => {
                        const boardId = boardOf(ctx).id;
                        await ctx.send('whiteboard.leave', { boardId, clientId: ctx.state.get('a') });
                        await ctx.send('whiteboard.leave', { boardId, clientId: ctx.state.get('b') });
                        const line = (await storedElements(ctx, boardId)).find((el) => el.id === 'e2e-line');
                        if (line?.versionNonce !== 100) throw new Error('La scène écrite n’a pas le trait gagnant');
                    }
                }
            ]
        },
        {
            id: 'sharing',
            label: 'Partager, copier et déplacer un tableau',
            steps: [
                {
                    label: 'Un tableau avec une image, et un second espace',
                    run: async (ctx) => {
                        const board = await addBoard(ctx, 'Essai de partage', [
                            element('e2e-image', { type: 'image', fileId: FILE_ID })
                        ]);
                        ctx.state.set('board', board);
                        await ctx.send('whiteboard.fileAdd', {
                            boardId: board.id,
                            fileId: FILE_ID,
                            mimeType: 'image/png',
                            dataURL: PIXEL
                        });
                        const { workspace } = await ctx.send<{ workspace: { id: number } }>('workspace.add', {
                            name: 'Essai tableau blanc'
                        });
                        ctx.state.set('ws', workspace.id);
                        ctx.defer('Supprimer le second espace', async () => {
                            await ctx.send('workspace.delete', { workspaceId: workspace.id });
                        });
                    }
                },
                {
                    label: 'Le projeter dans le second espace',
                    run: async (ctx) => {
                        const boardId = boardOf(ctx).id;
                        const ws = ctx.state.get('ws') as number;
                        await ctx.send('share.set', {
                            feature: 'whiteboard',
                            itemId: String(boardId),
                            workspaceId: ws,
                            shared: true
                        });
                        const { boards } = await ctx.send<{ boards: BoardSummary[] }>(
                            'whiteboard.list',
                            {},
                            { workspaceId: ws }
                        );
                        if (!boards.find((b) => b.id === boardId)?.foreign)
                            throw new Error('Le tableau n’y paraît pas projeté');
                        const { files } = await ctx.send<{ files: unknown[] }>(
                            'whiteboard.files',
                            { boardId, fileIds: [FILE_ID] },
                            { workspaceId: ws }
                        );
                        if (files.length !== 1) throw new Error('L’image n’est pas lisible depuis le second espace');
                    }
                },
                {
                    label: 'Le copier : de nouveaux objets, les mêmes octets',
                    run: async (ctx) => {
                        const boardId = boardOf(ctx).id;
                        const ws = ctx.state.get('ws') as number;
                        const ref = { feature: 'whiteboard', itemId: String(boardId) };
                        const manifest = await ctx.send<{
                            exportId: string;
                            bytes: number;
                            chunks: number;
                            sha256: string;
                        }>('share.copyExport', ref);
                        const chunks: string[] = [];
                        for (let index = 0; index < manifest.chunks; index++) {
                            chunks.push(
                                (
                                    await ctx.send<{ data: string }>('share.copyChunk', {
                                        exportId: manifest.exportId,
                                        index
                                    })
                                ).data
                            );
                        }
                        const { importId } = await ctx.send<{ importId: string }>(
                            'share.copyBegin',
                            {
                                feature: 'whiteboard',
                                bytes: manifest.bytes,
                                chunks: manifest.chunks,
                                sha256: manifest.sha256
                            },
                            { workspaceId: ws }
                        );
                        for (const [index, data] of chunks.entries()) {
                            await ctx.send('share.copyPut', { importId, index, data }, { workspaceId: ws });
                        }
                        const { itemId } = await ctx.send<{ itemId: string }>(
                            'share.copyCommit',
                            { importId, feature: 'whiteboard' },
                            { workspaceId: ws }
                        );
                        ctx.defer('Supprimer la copie', async () => {
                            await ctx.send('whiteboard.remove', { boardId: Number(itemId) }, { workspaceId: ws });
                        });
                        const [original] = await ctx.repo.files.listOf(boardId);
                        const [copied] = await ctx.repo.files.listOf(Number(itemId));
                        if (!original || !copied || original.object_key === copied.object_key) {
                            throw new Error('La copie ne porte pas son propre objet');
                        }
                        const { files } = await ctx.send<{ files: { dataURL: string }[] }>(
                            'whiteboard.files',
                            { boardId: Number(itemId), fileIds: [FILE_ID] },
                            { workspaceId: ws }
                        );
                        if (files[0]?.dataURL !== PIXEL) throw new Error('L’image copiée diffère');
                    }
                },
                {
                    label: 'Le déplacer : la scène se relit, les images ne bougent pas',
                    run: async (ctx) => {
                        const boardId = boardOf(ctx).id;
                        const ws = ctx.state.get('ws') as number;
                        const before = await ctx.repo.files.objectKeysOf(boardId);
                        await ctx.send('share.move', {
                            feature: 'whiteboard',
                            itemId: String(boardId),
                            workspaceId: ws
                        });
                        // Ses objets partent avec lui, avant que l'espace ne soit supprimé.
                        ctx.defer('Supprimer le tableau déplacé', async () => {
                            await ctx.send('whiteboard.remove', { boardId }, { workspaceId: ws });
                        });
                        const after = await ctx.repo.files.objectKeysOf(boardId);
                        if (before.join() !== after.join()) throw new Error('Les clés des images ont changé');
                        if ((await storedElements(ctx, boardId)).length !== 1)
                            throw new Error('La scène ne se relit pas');
                    }
                }
            ]
        }
    ]
};
