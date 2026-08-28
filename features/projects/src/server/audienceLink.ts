import { projectAudienceLink, projectAudienceList, projectAudienceUnlink } from '../contracts/commands';
import { AUDIENCE_ITEMS_PROVIDER, type AudienceItemsProvider } from '@deveye/types/sdk';
import { defineSdkFeature, FeatureError } from '@deveye/types/sdk/server';

import { assertAtHome, linkLabels, loadProject, WRITE, type Ctx } from './_shared';

/**
 * Le pointeur d'un projet vers des sites suivis.
 *
 * Exactement la même forme que `repoLink.ts` et `databaseLink.ts`, et pour les
 * mêmes raisons : le site appartient à l'espace, le projet n'en garde qu'une
 * liaison, et supprimer l'un ne supprime jamais l'autre.
 *
 * Gardé sous `projects: write` : c'est le projet qu'on modifie ici, pas le
 * site. Lire les statistiques relève, elles, du droit `audience` : un membre
 * peut avoir l'un sans l'autre, et l'onglet le dit plutôt que d'afficher un
 * écran vide qui se lirait comme un bug. Les sites sont nommés par le contrat
 * du module (`labelOf`, sous le codec du domicile du projet), et la liaison se
 * pose et se retire au domicile seulement (`assertAtHome`).
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

        // Un projet confidentiel ne peut pas être lié : la liaison est une ligne
        // en clair, le site vit à l'étage ouvert, et son ingestion tourne sans
        // session. Accepter la liaison reviendrait à promettre une
        // confidentialité qu'on ne tient pas.
        if (project.security_tier === 'guarded') {
            throw new FeatureError('validation', 'Un projet confidentiel ne peut pas être relié à un site suivi.');
        }

        // Le site existe-t-il, et dans **cet** espace ? Sans cette garde on
        // lierait n'importe quel identifiant, y compris celui d'un site d'un
        // autre espace, dont l'existence même n'a pas à fuiter.
        //
        // La question passe par le contrat que le module Audience offre
        // (`AUDIENCE_ITEMS_PROVIDER`) : Projets ne lit pas sa table, et dégrade
        // proprement quand le module est absent.
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
