import { projectRepoLink, projectRepoList, projectRepoUnlink } from 'deveye-types';
import { defineFeature, FeatureError, type FeatureDefinition } from '../_define';
import { loadProject, recordEvent } from './_shared';

/**
 * Le pointeur d'un projet vers des dépôts de l'espace.
 *
 * Trois commandes seulement : **le dépôt n'appartient pas au projet.** Il vit
 * dans la feature Git, qui porte son cache, sa synchronisation et ses jetons.
 * Ce qui suit ne fait que poser et retirer un pointeur — d'où le fait que tout
 * y soit un `repoId` et rien d'autre.
 *
 * **Plusieurs dépôts par projet** depuis la migration 069 : un projet réel se
 * compose souvent d'un client, d'un serveur et de contrats partagés, chacun dans
 * son dépôt. La liaison est donc non exclusive dans les deux sens, comme celle
 * aux bases de données et aux services surveillés.
 *
 * Gardé sous `projects: write` : c'est le projet qu'on modifie ici, pas le
 * dépôt. Lire son contenu relève, lui, du droit `git`.
 */

const READ = { feature: 'projects' } as const;
const WRITE = { feature: 'projects', level: 'write' } as const;

export const projectRepoListFeature: FeatureDefinition<
    typeof projectRepoList.command,
    typeof projectRepoList.input,
    typeof projectRepoList.output
> = defineFeature({
    ...projectRepoList,
    access: READ,
    handler: async (ctx, input) => {
        await loadProject(ctx, input.projectId);
        return { repoIds: await ctx.db.git.listLinkedRepoIds(input.projectId, ctx.workspaceId) };
    }
});

export const projectRepoLinkFeature: FeatureDefinition<
    typeof projectRepoLink.command,
    typeof projectRepoLink.input,
    typeof projectRepoLink.output
> = defineFeature({
    ...projectRepoLink,
    mutates: ['projects', 'git'],
    access: WRITE,
    handler: async (ctx, input) => {
        const project = await loadProject(ctx, input.projectId);

        // Un projet confidentiel ne peut pas être lié : la liaison est une ligne
        // en clair, le dépôt vit à l'étage ouvert, et la synchronisation tourne
        // sans session. Accepter reviendrait à promettre une confidentialité
        // qu'on ne tient pas.
        if (project.security_tier === 'guarded') {
            throw new FeatureError('validation', 'Un projet confidentiel ne peut pas être relié à un dépôt.');
        }

        // Le dépôt existe-t-il, et dans **cet** espace ? Sans cette garde on
        // lierait n'importe quel identifiant, y compris celui d'un dépôt d'un
        // autre espace — dont l'existence même n'a pas à fuiter.
        const repo = await ctx.db.git.findRepo(input.repoId, ctx.workspaceId);
        if (!repo) throw new FeatureError('not_found', 'Ce dépôt n’existe pas dans cet espace.');

        await ctx.db.git.linkProject(input.projectId, ctx.workspaceId, input.repoId);
        await recordEvent(ctx, project, { kind: 'project.repoLink', label: 'Dépôt git relié' });
        ctx.audit({
            action: 'project.repoLink',
            description: 'Dépôt git relié au projet',
            metadata: { projectId: input.projectId, repoId: input.repoId }
        });
        return { repoIds: await ctx.db.git.listLinkedRepoIds(input.projectId, ctx.workspaceId) };
    }
});

export const projectRepoUnlinkFeature: FeatureDefinition<
    typeof projectRepoUnlink.command,
    typeof projectRepoUnlink.input,
    typeof projectRepoUnlink.output
> = defineFeature({
    ...projectRepoUnlink,
    mutates: ['projects', 'git'],
    access: WRITE,
    handler: async (ctx, input) => {
        const project = await loadProject(ctx, input.projectId);
        // Le dépôt et son cache survivent : ils appartiennent à l'espace, et
        // d'autres projets peuvent s'en servir.
        const ok = await ctx.db.git.unlinkProject(input.projectId, ctx.workspaceId, input.repoId);
        if (ok) await recordEvent(ctx, project, { kind: 'project.repoUnlink', label: 'Dépôt git délié' });
        return { repoIds: await ctx.db.git.listLinkedRepoIds(input.projectId, ctx.workspaceId) };
    }
});

export const projectRepoLinkFeatures = [projectRepoListFeature, projectRepoLinkFeature, projectRepoUnlinkFeature];
