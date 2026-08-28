import { projectEventList } from '../contracts/commands';
import { PROJECT_EVENT_PAGE_SIZE, projectEventSchema } from '../contracts/domain';
import type { ProjectEvent, ProjectEventRow } from '../contracts/domain';
import { defineSdkFeature, type SdkCipher } from '@deveye/types/sdk/server';

import { assertProjectUnlocked, loadProject, projectCipher, type Ctx, type StoredEvent } from './_shared';

/**
 * La frise verticale d'un projet.
 *
 * Lecture seule : rien ne s'écrit ici depuis le client. Les événements sont
 * posés par les mutations elles-mêmes (`recordEvent`), au moment où le fait se
 * produit, et par les autres modules à travers le contrat d'usage
 * (`PROJECTS_USAGE_PROVIDER.recordEvent`, un déploiement parti de l'onglet
 * d'un projet) : c'est ce qui garantit qu'aucune histoire ne peut être
 * réécrite après coup. Elle se lit chez le projet, sous son codec, depuis une
 * fenêtre comme chez lui ; ses acteurs sont des identifiants, que le client
 * nomme parmi les membres de l'espace actif et masque sinon.
 */

/** Ne lève jamais : un événement illisible reste sur la frise, sans son libellé. */
async function decryptEvent(cipher: SdkCipher, content: string): Promise<StoredEvent> {
    const plain = await cipher.tryDecrypt(content);
    if (plain === null) return { label: '', from: null, to: null };
    try {
        const parsed = JSON.parse(plain) as Partial<StoredEvent>;
        return {
            label: typeof parsed.label === 'string' ? parsed.label : '',
            from: typeof parsed.from === 'string' ? parsed.from : null,
            to: typeof parsed.to === 'string' ? parsed.to : null
        };
    } catch {
        return { label: '', from: null, to: null };
    }
}

function toEvent(row: ProjectEventRow, payload: StoredEvent): ProjectEvent {
    return projectEventSchema.parse({
        id: row.id,
        projectId: row.project_id,
        actorUserId: row.actor_user_id,
        kind: row.kind,
        refType: row.ref_type,
        refId: row.ref_id,
        label: payload.label,
        from: payload.from,
        to: payload.to,
        created: row.created
    });
}

export const projectEventListFeature = defineSdkFeature({
    ...projectEventList,
    handler: async (ctx: Ctx, input) => {
        const project = await loadProject(ctx, input.projectId);
        await assertProjectUnlocked(ctx, project);

        const limit = input.limit ?? PROJECT_EVENT_PAGE_SIZE;
        // Une ligne de plus que demandé : sa présence dit qu'il reste de la
        // frise en dessous, sans second COUNT.
        const rows = await ctx.repo.history.listByProject(
            input.projectId,
            project.workspace_id,
            input.before ?? null,
            limit + 1
        );
        const hasMore = rows.length > limit;
        const page = hasMore ? rows.slice(0, limit) : rows;

        const cipher = await projectCipher(ctx, project);
        const events = await Promise.all(
            page.map(async (row) => toEvent(row, await decryptEvent(cipher, row.content)))
        );
        return { events, hasMore };
    }
});

export const projectHistoryFeatures = [projectEventListFeature];
