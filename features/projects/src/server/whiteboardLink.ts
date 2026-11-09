import { projectWhiteboardLink, projectWhiteboardList, projectWhiteboardUnlink } from '../contracts/commands';
import { WHITEBOARD_ITEMS_PROVIDER, type WhiteboardItemsProvider } from '@deveye/types/sdk';
import { defineSdkFeature, FeatureError } from '@deveye/types/sdk/server';

import { assertAtHome, linkLabels, LINKS, loadProject, type Ctx } from './_shared';

/**
 * Le pointeur d'un projet vers des tableaux blancs, même forme que
 * `hostingLink.ts`. Les gestes ne battent que `projects` : la liste des
 * tableaux ne montre rien des projets, et le démarrage refuserait le sujet
 * d'un module désinstallé.
 */

export const projectWhiteboardListFeature = defineSdkFeature({
    ...projectWhiteboardList,
    handler: async (ctx: Ctx, input) => {
        const project = await loadProject(ctx, input.projectId);
        const boardIds = await ctx.repo.links.listBoardIds(input.projectId, project.workspace_id);
        const whiteboard = ctx.providers.get<WhiteboardItemsProvider>(WHITEBOARD_ITEMS_PROVIDER);
        return { boardIds, labels: await linkLabels(whiteboard, boardIds, project.workspace_id) };
    }
});

export const projectWhiteboardLinkFeature = defineSdkFeature({
    ...projectWhiteboardLink,
    mutates: ['projects'],
    access: LINKS,
    handler: async (ctx: Ctx, input) => {
        const project = await loadProject(ctx, input.projectId, 'write');
        assertAtHome(ctx, project, 'relier un tableau blanc');
        // La liaison est une ligne en clair, et le tableau vit à l'étage ouvert.
        if (project.security_tier === 'guarded') {
            throw new FeatureError('validation', 'Un projet confidentiel ne peut pas être relié à un tableau blanc.');
        }

        const whiteboard = ctx.providers.get<WhiteboardItemsProvider>(WHITEBOARD_ITEMS_PROVIDER);
        if (!whiteboard) throw new FeatureError('validation', 'Le module Tableau blanc n’est pas installé.');
        if (!(await whiteboard.exists(input.boardId, project.workspace_id))) {
            throw new FeatureError('not_found', 'Ce tableau n’existe pas dans cet espace.');
        }

        await ctx.repo.links.linkBoard(input.projectId, project.workspace_id, input.boardId);
        return { boardIds: await ctx.repo.links.listBoardIds(input.projectId, project.workspace_id) };
    }
});

export const projectWhiteboardUnlinkFeature = defineSdkFeature({
    ...projectWhiteboardUnlink,
    mutates: ['projects'],
    access: LINKS,
    handler: async (ctx: Ctx, input) => {
        const project = await loadProject(ctx, input.projectId, 'write');
        assertAtHome(ctx, project, 'délier un tableau blanc');
        await ctx.repo.links.unlinkBoard(input.projectId, project.workspace_id, input.boardId);
        return { boardIds: await ctx.repo.links.listBoardIds(input.projectId, project.workspace_id) };
    }
});

export const projectWhiteboardLinkFeatures = [
    projectWhiteboardListFeature,
    projectWhiteboardLinkFeature,
    projectWhiteboardUnlinkFeature
];
