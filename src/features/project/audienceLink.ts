import { projectAudienceLink, projectAudienceList, projectAudienceUnlink } from '@deveye/types';
import { AUDIENCE_ITEMS_PROVIDER, type AudienceItemsProvider } from '@deveye/types/sdk';
import { moduleProvider } from '@/features/_sdk/register';
import { defineFeature, FeatureError, type FeatureDefinition } from '../_define';
import { loadProject } from './_shared';

/**
 * Le pointeur d'un projet vers des sites suivis.
 *
 * Exactement la même forme que `repoLink.ts` et `databaseLink.ts`, et pour les
 * mêmes raisons : le site appartient à l'espace, le projet n'en garde qu'une
 * liaison, et supprimer l'un ne supprime jamais l'autre.
 *
 * Gardé sous `projects: write` : c'est le projet qu'on modifie ici, pas le
 * site. Lire les statistiques relève, elles, du droit `audience` — un membre
 * peut avoir l'un sans l'autre, et l'onglet le dit plutôt que d'afficher un
 * écran vide qui se lirait comme un bug.
 */

const READ = { feature: 'projects' } as const;
const WRITE = { feature: 'projects', level: 'write' } as const;

export const projectAudienceListFeature: FeatureDefinition<
    typeof projectAudienceList.command,
    typeof projectAudienceList.input,
    typeof projectAudienceList.output
> = defineFeature({
    ...projectAudienceList,
    access: READ,
    handler: async (ctx, input) => {
        await loadProject(ctx, input.projectId);
        return { siteIds: await ctx.db.projectLinks.listSiteIds(input.projectId, ctx.workspaceId) };
    }
});

export const projectAudienceLinkFeature: FeatureDefinition<
    typeof projectAudienceLink.command,
    typeof projectAudienceLink.input,
    typeof projectAudienceLink.output
> = defineFeature({
    ...projectAudienceLink,
    mutates: ['projects', 'audience'],
    access: WRITE,
    handler: async (ctx, input) => {
        const project = await loadProject(ctx, input.projectId);

        // Un projet confidentiel ne peut pas être lié : la liaison est une ligne
        // en clair, le site vit à l'étage ouvert, et son ingestion tourne sans
        // session. Accepter la liaison reviendrait à promettre une
        // confidentialité qu'on ne tient pas.
        if (project.security_tier === 'guarded') {
            throw new FeatureError('validation', 'Un projet confidentiel ne peut pas être relié à un site suivi.');
        }

        // Le site existe-t-il, et dans **cet** espace ? Sans cette garde on
        // lierait n'importe quel identifiant, y compris celui d'un site d'un
        // autre espace — dont l'existence même n'a pas à fuiter.
        //
        // Depuis le rapatriement d'Audience en module, la question passe par le
        // contrat qu'il offre (`AUDIENCE_ITEMS_PROVIDER`) : Projets ne lit plus
        // sa table, et dégrade proprement quand le module est absent.
        const audience = moduleProvider<AudienceItemsProvider>(AUDIENCE_ITEMS_PROVIDER);
        if (!audience) throw new FeatureError('validation', 'Le module Audience n’est pas installé.');
        if (!(await audience.exists(input.siteId, ctx.workspaceId))) {
            throw new FeatureError('not_found', 'Ce site n’existe pas dans cet espace.');
        }

        await ctx.db.projectLinks.linkSite(input.projectId, ctx.workspaceId, input.siteId);
        return { siteIds: await ctx.db.projectLinks.listSiteIds(input.projectId, ctx.workspaceId) };
    }
});

export const projectAudienceUnlinkFeature: FeatureDefinition<
    typeof projectAudienceUnlink.command,
    typeof projectAudienceUnlink.input,
    typeof projectAudienceUnlink.output
> = defineFeature({
    ...projectAudienceUnlink,
    mutates: ['projects', 'audience'],
    access: WRITE,
    handler: async (ctx, input) => {
        await loadProject(ctx, input.projectId);
        // Le site lui-même n'est pas touché : seule la liaison tombe.
        await ctx.db.projectLinks.unlinkSite(input.projectId, ctx.workspaceId, input.siteId);
        return { siteIds: await ctx.db.projectLinks.listSiteIds(input.projectId, ctx.workspaceId) };
    }
});

export const projectAudienceLinkFeatures = [
    projectAudienceListFeature,
    projectAudienceLinkFeature,
    projectAudienceUnlinkFeature
];
