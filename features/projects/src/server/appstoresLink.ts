import { projectAppStoresLink, projectAppStoresList, projectAppStoresUnlink } from '../contracts/commands';
import { APPSTORES_ITEMS_PROVIDER, type AppStoresItemsProvider } from '@deveye/types/sdk';
import { defineSdkFeature, FeatureError } from '@deveye/types/sdk/server';

import { assertAtHome, linkLabels, LINKS, loadProject, type Ctx } from './_shared';

/**
 * Le pointeur d'un projet vers des apps des Stores, même forme que
 * `hostingLink.ts`. Les gestes battent aussi `appstores` : la liste du module
 * dit combien de projets tiennent chaque app.
 */

export const projectAppStoresListFeature = defineSdkFeature({
    ...projectAppStoresList,
    handler: async (ctx: Ctx, input) => {
        const project = await loadProject(ctx, input.projectId);
        const appIds = await ctx.repo.links.listAppIds(input.projectId, project.workspace_id);
        const appstores = ctx.providers.get<AppStoresItemsProvider>(APPSTORES_ITEMS_PROVIDER);
        return { appIds, labels: await linkLabels(appstores, appIds, project.workspace_id) };
    }
});

export const projectAppStoresLinkFeature = defineSdkFeature({
    ...projectAppStoresLink,
    mutates: ['projects', 'appstores'],
    access: { ...LINKS, item: 'projectId' },
    handler: async (ctx: Ctx, input) => {
        const project = await loadProject(ctx, input.projectId, 'write');
        assertAtHome(ctx, project, 'relier une app');
        // La liaison est une ligne en clair, l'app vit à l'étage ouvert et sa
        // synchronisation tourne sans session.
        if (project.security_tier === 'guarded') {
            throw new FeatureError('validation', 'Un projet confidentiel ne peut pas être relié à une app.');
        }

        const appstores = ctx.providers.get<AppStoresItemsProvider>(APPSTORES_ITEMS_PROVIDER);
        if (!appstores) throw new FeatureError('validation', 'Le module Stores n’est pas installé.');
        if (!(await appstores.exists(input.appId, project.workspace_id))) {
            throw new FeatureError('not_found', 'Cette app n’existe pas dans cet espace.');
        }

        await ctx.repo.links.linkApp(input.projectId, project.workspace_id, input.appId);
        return { appIds: await ctx.repo.links.listAppIds(input.projectId, project.workspace_id) };
    }
});

export const projectAppStoresUnlinkFeature = defineSdkFeature({
    ...projectAppStoresUnlink,
    mutates: ['projects', 'appstores'],
    access: { ...LINKS, item: 'projectId' },
    handler: async (ctx: Ctx, input) => {
        const project = await loadProject(ctx, input.projectId, 'write');
        assertAtHome(ctx, project, 'délier une app');
        await ctx.repo.links.unlinkApp(input.projectId, project.workspace_id, input.appId);
        return { appIds: await ctx.repo.links.listAppIds(input.projectId, project.workspace_id) };
    }
});

export const projectAppStoresLinkFeatures = [
    projectAppStoresListFeature,
    projectAppStoresLinkFeature,
    projectAppStoresUnlinkFeature
];
