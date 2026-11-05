import { defaultUserColor } from '@deveye/types';
import { defineSdkFeature, FeatureError } from '@deveye/types/sdk/server';

import {
    whiteboardAdd,
    whiteboardCount,
    whiteboardDuplicate,
    whiteboardFileAdd,
    whiteboardFiles,
    whiteboardJoin,
    whiteboardLeave,
    whiteboardList,
    whiteboardPointer,
    whiteboardPreviews,
    whiteboardPush,
    whiteboardRemove,
    whiteboardRename,
    whiteboardSetPreview
} from '../contracts/commands';
import { SCENE_MAX_BYTES, type SceneElement } from '../contracts/domain';
import {
    fileIdsOf,
    now,
    openScene,
    openTitle,
    sceneJson,
    sealScene,
    sealTitle,
    summaryOf,
    untitled,
    whiteboard,
    type Ctx
} from './_shared';
import { addFile, copyObject, readFiles } from './files';
import type { BoardRow } from './repo';

/** Ceux que ce rôle voit : une restriction qui masque fait disparaître, plutôt que griser. */
async function visibleBoards(ctx: Ctx): Promise<BoardRow[]> {
    const [rows, hidden] = await Promise.all([ctx.repo.boards.listVisible(ctx.workspaceId), ctx.items.restrictions()]);
    return rows.filter((row) => hidden.get(String(row.id)) !== 'none');
}

async function loadBoard(ctx: Ctx, boardId: number): Promise<BoardRow> {
    const row = await ctx.repo.boards.findVisible(boardId, ctx.workspaceId);
    if (row === null) throw new FeatureError('not_found', 'Ce tableau n’existe plus.');
    return row;
}

async function summaryFor(ctx: Ctx, boardId: number) {
    const row = await loadBoard(ctx, boardId);
    const cipher = await (await ctx.sharing.scope()).cipherFor(String(row.id));
    return summaryOf(row, await openTitle(cipher, row.content), row.workspace_id !== ctx.workspaceId);
}

/** Les éléments d'un import, sans ce qui est déjà supprimé : rien à garder d'un autre outil. */
function importable(elements: readonly SceneElement[] | undefined): SceneElement[] {
    return (elements ?? []).filter((el) => !el.isDeleted);
}

const canWriteItem = (ctx: Ctx, boardId: number): Promise<boolean> =>
    ctx.items.assert(String(boardId), 'write').then(
        () => true,
        () => false
    );

export const whiteboardHandlers = [
    defineSdkFeature({
        ...whiteboardList,
        handler: async (ctx: Ctx) => {
            const [rows, scope, usage] = await Promise.all([
                visibleBoards(ctx),
                ctx.sharing.scope(),
                ctx.quota.usage('storage')
            ]);
            const boards = await Promise.all(
                rows.map(async (row) =>
                    summaryOf(
                        row,
                        await openTitle(await scope.cipherFor(String(row.id)), row.content),
                        row.workspace_id !== ctx.workspaceId
                    )
                )
            );
            return { boards, usage };
        }
    }),

    defineSdkFeature({
        ...whiteboardCount,
        handler: async (ctx: Ctx) => ({ count: (await visibleBoards(ctx)).length })
    }),

    defineSdkFeature({
        ...whiteboardAdd,
        access: { level: 'write' },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            const json = sceneJson(importable(input.elements));
            const sceneBytes = Buffer.byteLength(json, 'utf8');
            if (sceneBytes > SCENE_MAX_BYTES) {
                throw new FeatureError('validation', 'Ce dessin est trop volumineux : 8 Mo au plus, images à part.');
            }
            await ctx.quota.assert(
                'storage',
                async (owned) => (await ctx.repo.boards.storedBytesIn(owned)) + sceneBytes + (input.filesBytes ?? 0)
            );
            const cipher = ctx.cipher();
            const scene = await sealScene(cipher, json);
            const id = await ctx.repo.boards.create({
                workspaceId: ctx.workspaceId,
                userId: ctx.userId,
                content: await sealTitle(cipher, input.title),
                scene: scene.sealed,
                sceneBytes: scene.bytes,
                at: now()
            });
            ctx.audit({ action: 'whiteboard.add', description: 'Tableau blanc créé', metadata: { boardId: id } });
            return { board: await summaryFor(ctx, id) };
        }
    }),

    defineSdkFeature({
        ...whiteboardRename,
        access: { level: 'write', item: 'boardId' },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            const row = await loadBoard(ctx, input.boardId);
            const cipher = await (await ctx.sharing.scope()).cipherFor(String(row.id));
            await ctx.repo.boards.rename(
                row.id,
                row.workspace_id,
                await sealTitle(cipher, input.title),
                ctx.userId,
                now()
            );
            return { board: await summaryFor(ctx, row.id) };
        }
    }),

    defineSdkFeature({
        ...whiteboardDuplicate,
        access: { level: 'write' },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            await ctx.items.assert(String(input.boardId), 'read');
            const source = await loadBoard(ctx, input.boardId);
            const runtime = whiteboard();
            await runtime.sessions.flushNow(source.id);

            const sourceCipher = runtime.cipherFor(source.workspace_id);
            const stored = await ctx.repo.boards.loadScene(source.id);
            if (stored === null) throw new FeatureError('not_found', 'Ce tableau n’existe plus.');
            const elements = await openScene(sourceCipher, stored.scene);
            if (elements === null) throw new FeatureError('internal', 'Ce tableau est illisible : copie annulée.');
            const json = sceneJson(elements.filter((el) => !el.isDeleted));
            const keep = new Set(fileIdsOf(elements));
            const files = (await ctx.repo.files.listOf(source.id)).filter((f) => keep.has(f.file_id));
            const filesBytes = files.reduce((sum, f) => sum + Number(f.bytes), 0);

            await ctx.quota.assert(
                'storage',
                async (owned) =>
                    (await ctx.repo.boards.storedBytesIn(owned)) + Buffer.byteLength(json, 'utf8') + filesBytes
            );
            const cipher = ctx.cipher();
            const title = await openTitle(sourceCipher, source.content);
            const scene = await sealScene(cipher, json);
            const at = now();
            const id = await ctx.repo.boards.create({
                workspaceId: ctx.workspaceId,
                userId: ctx.userId,
                content: await sealTitle(cipher, `${untitled(title)} (copie)`),
                scene: scene.sealed,
                sceneBytes: scene.bytes,
                at
            });
            const copied: string[] = [];
            try {
                for (const file of files) {
                    const objectKey = await copyObject(file.object_key);
                    copied.push(objectKey);
                    await ctx.repo.files.insert({
                        boardId: id,
                        fileId: file.file_id,
                        mime: file.mime,
                        bytes: Number(file.bytes),
                        objectKey,
                        at
                    });
                }
            } catch (error) {
                // Une copie à moitié faite n'a pas lieu d'être : ni ligne, ni objet.
                await ctx.repo.boards.remove(id, ctx.workspaceId);
                await Promise.allSettled(copied.map((key) => runtime.objects.delete(key)));
                throw error;
            }
            return { board: await summaryFor(ctx, id) };
        }
    }),

    defineSdkFeature({
        ...whiteboardRemove,
        access: { level: 'write', item: 'boardId' },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            const row = await loadBoard(ctx, input.boardId);
            // Supprimer depuis un espace qui ne fait que le voir détruirait le tableau d'un autre.
            if (row.workspace_id !== ctx.workspaceId) {
                throw new FeatureError(
                    'forbidden',
                    'Ce tableau appartient à un autre espace. Retirez-le d’ici depuis ses réglages de partage, ou supprimez-le depuis son espace d’origine.'
                );
            }
            const runtime = whiteboard();
            await runtime.sessions.close(row.id, 'removed', { discard: true });
            const objectKeys = await ctx.repo.files.objectKeysOf(row.id);
            await ctx.repo.boards.remove(row.id, row.workspace_id);
            await ctx.items.forget(String(row.id));
            // Au mieux : un objet resté là est retiré par le balayage, qui ne lui trouve plus de ligne.
            await Promise.allSettled(objectKeys.map((key) => runtime.objects.delete(key)));
            ctx.audit({
                action: 'whiteboard.remove',
                description: 'Tableau blanc supprimé',
                metadata: { boardId: row.id }
            });
            return { boardId: row.id };
        }
    }),

    defineSdkFeature({
        ...whiteboardPreviews,
        handler: async (ctx: Ctx, input) => {
            const visible = new Set((await visibleBoards(ctx)).map((row) => row.id));
            const wanted = input.boardIds.filter((id) => visible.has(id));
            const [rows, scope] = await Promise.all([ctx.repo.boards.previews(wanted), ctx.sharing.scope()]);
            const previews = [];
            for (const row of rows) {
                const dataURL = await (await scope.cipherFor(String(row.id))).tryDecrypt(row.preview);
                if (dataURL !== null) previews.push({ boardId: row.id, dataURL });
            }
            return { previews };
        }
    }),

    defineSdkFeature({
        ...whiteboardSetPreview,
        access: { level: 'write', item: 'boardId' },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            const row = await loadBoard(ctx, input.boardId);
            const cipher = await (await ctx.sharing.scope()).cipherFor(String(row.id));
            await ctx.repo.boards.setPreview(
                row.id,
                row.workspace_id,
                await cipher.encrypt(input.dataURL),
                input.dataURL.length
            );
            return { boardId: row.id };
        }
    }),

    defineSdkFeature({
        ...whiteboardFileAdd,
        access: { level: 'write', item: 'boardId' },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            const row = await loadBoard(ctx, input.boardId);
            const title = await openTitle(await (await ctx.sharing.scope()).cipherFor(String(row.id)), row.content);
            const { created } = await addFile({
                repo: ctx.repo,
                providers: ctx.providers,
                board: row,
                title: untitled(title),
                userId: ctx.userId,
                fileId: input.fileId,
                mime: input.mimeType,
                dataURL: input.dataURL
            });
            if (created) whiteboard().sessions.notifyFile(row.id, input.fileId);
            return { fileId: input.fileId, created };
        }
    }),

    defineSdkFeature({
        ...whiteboardFiles,
        access: { item: 'boardId' },
        handler: async (ctx: Ctx, input) => {
            const row = await loadBoard(ctx, input.boardId);
            return readFiles(await ctx.repo.files.findMany(row.id, input.fileIds), input.fileIds);
        }
    }),

    defineSdkFeature({
        ...whiteboardJoin,
        access: { item: 'boardId' },
        handler: async (ctx: Ctx, input) => {
            const row = await loadBoard(ctx, input.boardId);
            const [members, canWrite, scope, fileRows] = await Promise.all([
                ctx.deveye.members.list(),
                canWriteItem(ctx, row.id),
                ctx.sharing.scope(),
                ctx.repo.files.listOf(row.id)
            ]);
            const me = members.find((m) => m.userId === ctx.userId);
            const joined = await whiteboard().sessions.join({
                boardId: row.id,
                home: row.workspace_id,
                clientId: input.clientId,
                userId: ctx.userId,
                workspaceId: ctx.workspaceId,
                name: me?.name ?? 'Membre',
                color: me?.color ?? defaultUserColor(ctx.userId),
                canWrite
            });
            return {
                ...joined,
                title: await openTitle(await scope.cipherFor(String(row.id)), row.content),
                fileIds: fileRows.map((f) => f.file_id),
                canWrite
            };
        }
    }),

    defineSdkFeature({
        ...whiteboardLeave,
        access: { item: 'boardId' },
        handler: async (ctx: Ctx, input) => {
            await whiteboard().sessions.leave(input.boardId, input.clientId, ctx.userId);
            return {};
        }
    }),

    defineSdkFeature({
        ...whiteboardPush,
        access: { level: 'write', item: 'boardId' },
        handler: (ctx: Ctx, input) =>
            Promise.resolve(whiteboard().sessions.push(input.boardId, input.clientId, ctx.userId, input.elements))
    }),

    defineSdkFeature({
        ...whiteboardPointer,
        access: { item: 'boardId' },
        handler: (ctx: Ctx, input) => {
            whiteboard().sessions.pointer(input.boardId, input.clientId, ctx.userId, {
                pointer: input.pointer,
                button: input.button,
                selectedIds: input.selectedIds
            });
            return Promise.resolve({});
        }
    })
];
