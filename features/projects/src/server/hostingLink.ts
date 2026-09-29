import { projectHostingLink, projectHostingList, projectHostingUnlink } from '../contracts/commands';
import { HOSTING_ITEMS_PROVIDER, type HostingItemsProvider } from '@deveye/types/sdk';
import { defineSdkFeature, FeatureError } from '@deveye/types/sdk/server';

import { assertAtHome, linkLabels, LINKS, loadProject, type Ctx } from './_shared';

/**
 * Le pointeur d'un projet vers des dossiers d'Hébergement, même forme que
 * `audienceLink.ts`. Hébergement est un module privé : absent, rien ne se
 * relie et la liste ne nomme rien. Les gestes ne battent que `projects` : le
 * démarrage refuse un sujet qu'aucun module installé ne déclare.
 */

export const projectHostingListFeature = defineSdkFeature({
    ...projectHostingList,
    handler: async (ctx: Ctx, input) => {
        const project = await loadProject(ctx, input.projectId);
        const packIds = await ctx.repo.links.listPackIds(input.projectId, project.workspace_id);
        const hosting = ctx.providers.get<HostingItemsProvider>(HOSTING_ITEMS_PROVIDER);
        return { packIds, labels: await linkLabels(hosting, packIds, project.workspace_id) };
    }
});

export const projectHostingLinkFeature = defineSdkFeature({
    ...projectHostingLink,
    mutates: ['projects'],
    access: LINKS,
    handler: async (ctx: Ctx, input) => {
        const project = await loadProject(ctx, input.projectId, 'write');
        assertAtHome(ctx, project, 'relier un dossier');
        if (project.security_tier === 'guarded') {
            throw new FeatureError('validation', 'Un projet confidentiel ne peut pas être relié à un dossier.');
        }

        const hosting = ctx.providers.get<HostingItemsProvider>(HOSTING_ITEMS_PROVIDER);
        if (!hosting) throw new FeatureError('validation', 'Le module Hébergement n’est pas installé.');
        if (!(await hosting.exists(input.packId, project.workspace_id))) {
            throw new FeatureError('not_found', 'Ce dossier n’existe pas dans cet espace.');
        }

        await ctx.repo.links.linkPack(input.projectId, project.workspace_id, input.packId);
        return { packIds: await ctx.repo.links.listPackIds(input.projectId, project.workspace_id) };
    }
});

export const projectHostingUnlinkFeature = defineSdkFeature({
    ...projectHostingUnlink,
    mutates: ['projects'],
    access: LINKS,
    handler: async (ctx: Ctx, input) => {
        const project = await loadProject(ctx, input.projectId, 'write');
        assertAtHome(ctx, project, 'délier un dossier');
        await ctx.repo.links.unlinkPack(input.projectId, project.workspace_id, input.packId);
        return { packIds: await ctx.repo.links.listPackIds(input.projectId, project.workspace_id) };
    }
});

export const projectHostingLinkFeatures = [
    projectHostingListFeature,
    projectHostingLinkFeature,
    projectHostingUnlinkFeature
];
