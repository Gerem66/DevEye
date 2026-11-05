import type { SdkCipher, SdkQuota } from '@deveye/types/sdk/server';

import { SCENE_MAX_BYTES } from '../contracts/domain';
import { fileIdsOf, now, openScene, sceneJson, sealScene } from './_shared';
import type { WhiteboardRepo } from './repo';
import type { SceneStore } from './session/sessions';

/**
 * La scène d'un tableau en base, pour la séance : toujours sous la clé de son
 * espace d'origine, lue sans session (l'étage ouvert), jamais sous celle de
 * l'espace d'où on la regarde.
 */
export function createSceneStore(deps: {
    repo: WhiteboardRepo;
    cipherFor(workspaceId: number): SdkCipher;
    quotaFor(workspaceId: number): SdkQuota;
}): SceneStore {
    const { repo } = deps;
    return {
        async load(boardId) {
            const row = await repo.boards.loadScene(boardId);
            if (row === null) return null;
            const elements = (await openScene(deps.cipherFor(row.workspace_id), row.scene)) ?? [];
            return { workspaceId: row.workspace_id, version: Number(row.version), elements };
        },

        async save({ boardId, workspaceId, baseVersion, elements, userId }) {
            const json = sceneJson(elements);
            if (Buffer.byteLength(json, 'utf8') > SCENE_MAX_BYTES) return { ok: false, reason: 'tooLarge' };
            const encoded = await sealScene(deps.cipherFor(workspaceId), json);
            const at = now();
            const written = await repo.boards.saveScene({
                id: boardId,
                workspaceId,
                baseVersion,
                scene: encoded.sealed,
                sceneBytes: encoded.bytes,
                userId,
                at
            });
            if (!written) {
                const row = await repo.boards.loadScene(boardId);
                if (row === null) return { ok: false, reason: 'gone' };
                return { ok: false, reason: row.workspace_id === workspaceId ? 'stale' : 'moved' };
            }
            await repo.files.reconcileOrphans(boardId, fileIdsOf(elements), at);
            return { ok: true, version: baseVersion + 1 };
        },

        async ownerOverQuota(workspaceId) {
            const use = await deps.quotaFor(workspaceId).usage('storage');
            return use !== null && use.used >= use.limit;
        }
    };
}
