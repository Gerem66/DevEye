import { projectAudienceLink, projectAudienceList, projectAudienceUnlink } from '../contracts/commands';
import { AUDIENCE_ITEMS_PROVIDER, type AudienceItemsProvider } from '@deveye/types/sdk';
import { defineSdkFeature, FeatureError } from '@deveye/types/sdk/server';

import { assertAtHome, linkLabels, loadProject, WRITE, type Ctx } from './_shared';

/**
 * Le pointeur d'un projet vers des sites suivis, même forme que `repoLink.ts` : le
 * site appartient à l'espace, le projet n'en garde qu'une liaison. Gardé sous
 * `projects: write` : lire les statistiques relève du droit `audience`, qu'un membre
 * peut ne pas avoir, et l'onglet le dit plutôt que de montrer un écran vide.
 */

export const projectAudienceListFeature = defineSdkFeature({
    ...projectAudienceList,
    handler: async (ctx: Ctx, input) => {
        const project = await loadProject(ctx, input.projectId);
        const siteIds = await ctx.repo.links.listSiteIds(input.projectId, project.workspace_id);
        const audience = ctx.providers.get<AudienceItemsProvider>(AUDIENCE_ITEMS_PROVIDER);
        return { siteIds, labels: await linkLabels(audience, siteIds, project.workspace_id) };
    }
});

export const projectAudienceLinkFeature = defineSdkFeature({
    ...projectAudienceLink,
    mutates: ['projects', 'audience'],
    access: WRITE,
    handler: async (ctx: Ctx, input) => {
        const project = await loadProject(ctx, input.projectId, 'write');
        assertAtHome(ctx, project, 'relier un site suivi');

        // La liaison est une ligne en clair, le site vit à l'étage ouvert et son
        // ingestion tourne sans session : même refus que pour un dépôt.
        if (project.security_tier === 'guarded') {
            throw new FeatureError('validation', 'Un projet confidentiel ne peut pas être relié à un site suivi.');
        }

        // Seule la visibilité d'ici (chez lui ou projeté) est vérifiée, et par le
        // contrat qu'offre le module : sans cette garde on lierait l'identifiant
        // d'un site d'un espace qui ne partage rien ici, dont l'existence n'a pas
        // à fuiter.
        const audience = ctx.providers.get<AudienceItemsProvider>(AUDIENCE_ITEMS_PROVIDER);
        if (!audience) throw new FeatureError('validation', 'Le module Audience n’est pas installé.');
        if (!(await audience.exists(input.siteId, project.workspace_id))) {
            throw new FeatureError('not_found', 'Ce site n’existe pas dans cet espace.');
        }

        await ctx.repo.links.linkSite(input.projectId, project.workspace_id, input.siteId);
        return { siteIds: await ctx.repo.links.listSiteIds(input.projectId, project.workspace_id) };
    }
});

export const projectAudienceUnlinkFeature = defineSdkFeature({
    ...projectAudienceUnlink,
    mutates: ['projects', 'audience'],
    access: WRITE,
    handler: async (ctx: Ctx, input) => {
        const project = await loadProject(ctx, input.projectId, 'write');
        assertAtHome(ctx, project, 'délier un site suivi');
        // Le site lui-même n'est pas touché : seule la liaison tombe.
        await ctx.repo.links.unlinkSite(input.projectId, project.workspace_id, input.siteId);
        return { siteIds: await ctx.repo.links.listSiteIds(input.projectId, project.workspace_id) };
    }
});

export const projectAudienceLinkFeatures = [
    projectAudienceListFeature,
    projectAudienceLinkFeature,
    projectAudienceUnlinkFeature
];
