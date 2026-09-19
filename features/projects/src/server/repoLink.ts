import { projectRepoLink, projectRepoList, projectRepoUnlink } from '../contracts/commands';
import { GIT_ITEMS_PROVIDER, type GitItemsProvider } from '@deveye/types/sdk';
import { defineSdkFeature, FeatureError } from '@deveye/types/sdk/server';

import { assertAtHome, linkLabels, LINKS, loadProject, recordEvent, type Ctx } from './_shared';

/**
 * Le pointeur d'un projet vers des dépôts de l'espace : le dépôt n'appartient pas au
 * projet, il vit dans la feature Git avec son cache, sa synchronisation et ses
 * jetons. La liaison est non exclusive dans les deux sens, un projet réel se
 * composant souvent d'un client, d'un serveur et de contrats partagés.
 *
 * Gardé sous `projects: write` : c'est le projet qu'on modifie ici, pas le dépôt,
 * dont le contenu relève du droit `git`. La table de liaison appartient à Projets,
 * qui ne lit pas la table des dépôts et ne les connaît que par le contrat qu'offre
 * le module Git, lequel les nomme aussi.
 *
 * Ces liaisons battent deux sujets (`['projects', 'git']`) : la fiche d'un dépôt
 * montre les projets qui l'utilisent, et doit suivre.
 */

export const projectRepoListFeature = defineSdkFeature({
    ...projectRepoList,
    handler: async (ctx: Ctx, input) => {
        const project = await loadProject(ctx, input.projectId);
        const repoIds = await ctx.repo.links.listRepoIds(input.projectId, project.workspace_id);
        const repos = ctx.providers.get<GitItemsProvider>(GIT_ITEMS_PROVIDER);
        return { repoIds, labels: await linkLabels(repos, repoIds, project.workspace_id) };
    }
});

export const projectRepoLinkFeature = defineSdkFeature({
    ...projectRepoLink,
    mutates: ['projects', 'git'],
    access: LINKS,
    handler: async (ctx: Ctx, input) => {
        const project = await loadProject(ctx, input.projectId, 'write');
        assertAtHome(ctx, project, 'relier un dépôt');

        // La liaison est une ligne en clair, le dépôt vit à l'étage ouvert et la
        // synchronisation tourne sans session : accepter un projet confidentiel
        // promettrait une confidentialité qu'on ne tient pas.
        if (project.security_tier === 'guarded') {
            throw new FeatureError('validation', 'Un projet confidentiel ne peut pas être relié à un dépôt.');
        }

        // Le dépôt est-il visible de cet espace, chez lui ou projeté ? Sans cette
        // garde on lierait n'importe quel identifiant, dont celui d'un dépôt d'un
        // espace qui ne partage rien ici, dont l'existence n'a pas à fuiter. La
        // question passe par le contrat qu'offre le module Git : Projets ne lit pas
        // sa table, et dégrade proprement quand il est absent.
        const repos = ctx.providers.get<GitItemsProvider>(GIT_ITEMS_PROVIDER);
        if (!repos) throw new FeatureError('validation', 'Le module Git n’est pas installé.');
        if (!(await repos.exists(input.repoId, project.workspace_id))) {
            throw new FeatureError('not_found', 'Ce dépôt n’existe pas dans cet espace.');
        }

        await ctx.repo.links.linkRepo(input.projectId, project.workspace_id, input.repoId);
        await recordEvent(ctx, project, { kind: 'projects.repoLink', label: 'Dépôt git relié' });
        ctx.audit({
            action: 'projects.repoLink',
            description: 'Dépôt git relié au projet',
            metadata: { projectId: input.projectId, repoId: input.repoId }
        });
        return { repoIds: await ctx.repo.links.listRepoIds(input.projectId, project.workspace_id) };
    }
});

export const projectRepoUnlinkFeature = defineSdkFeature({
    ...projectRepoUnlink,
    mutates: ['projects', 'git'],
    access: LINKS,
    handler: async (ctx: Ctx, input) => {
        const project = await loadProject(ctx, input.projectId, 'write');
        assertAtHome(ctx, project, 'délier un dépôt');
        // Le dépôt et son cache survivent : ils appartiennent à l'espace, et
        // d'autres projets peuvent s'en servir.
        const ok = await ctx.repo.links.unlinkRepo(input.projectId, project.workspace_id, input.repoId);
        if (ok) await recordEvent(ctx, project, { kind: 'projects.repoUnlink', label: 'Dépôt git délié' });
        return { repoIds: await ctx.repo.links.listRepoIds(input.projectId, project.workspace_id) };
    }
});

export const projectRepoLinkFeatures = [projectRepoListFeature, projectRepoLinkFeature, projectRepoUnlinkFeature];
