import { projectRepoLink, projectRepoList, projectRepoUnlink } from '../contracts/commands';
import { GIT_ITEMS_PROVIDER, type GitItemsProvider } from '@deveye/types/sdk';
import { defineSdkFeature, FeatureError } from '@deveye/types/sdk/server';

import { assertAtHome, linkLabels, loadProject, recordEvent, WRITE, type Ctx } from './_shared';

/**
 * Le pointeur d'un projet vers des dépôts de l'espace.
 *
 * Trois commandes seulement : **le dépôt n'appartient pas au projet.** Il vit
 * dans la feature Git, qui porte son cache, sa synchronisation et ses jetons.
 * Ce qui suit ne fait que poser et retirer un pointeur, d'où le fait que tout
 * y soit un `repoId` et rien d'autre.
 *
 * **Plusieurs dépôts par projet** depuis la migration 069 : un projet réel se
 * compose souvent d'un client, d'un serveur et de contrats partagés, chacun dans
 * son dépôt. La liaison est donc non exclusive dans les deux sens, comme celle
 * aux bases de données et aux services surveillés.
 *
 * Gardé sous `projects: write` : c'est le projet qu'on modifie ici, pas le
 * dépôt. Lire son contenu relève, lui, du droit `git`.
 *
 * La table de liaison (`project_repo_links`) est celle de Projets, lue par
 * `ctx.repo.links` à côté des services surveillés, des bases et des cibles :
 * Projets ne lit pas la table des dépôts, et ne les connaît que par le contrat
 * que le module Git offre, qui les nomme aussi (`labelOf`, sous le codec du
 * domicile du projet, pour une fenêtre qui ne les verrait pas autrement).
 *
 * Domicile seulement pour poser et retirer (`assertAtHome`) : une liaison
 * référence un dépôt de l'espace d'origine, que la fenêtre ne voit pas.
 *
 * Ces liaisons battent deux sujets (`['projects', 'git']`) : la fiche d'un
 * dépôt montre les projets qui l'utilisent, et doit suivre.
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
    access: WRITE,
    handler: async (ctx: Ctx, input) => {
        const project = await loadProject(ctx, input.projectId, 'write');
        assertAtHome(ctx, project, 'relier un dépôt');

        // Un projet confidentiel ne peut pas être lié : la liaison est une ligne
        // en clair, le dépôt vit à l'étage ouvert, et la synchronisation tourne
        // sans session. Accepter reviendrait à promettre une confidentialité
        // qu'on ne tient pas.
        if (project.security_tier === 'guarded') {
            throw new FeatureError('validation', 'Un projet confidentiel ne peut pas être relié à un dépôt.');
        }

        // Le dépôt existe-t-il, et dans **cet** espace ? Sans cette garde on
        // lierait n'importe quel identifiant, y compris celui d'un dépôt d'un
        // autre espace, dont l'existence même n'a pas à fuiter.
        //
        // La question passe par le contrat que le module Git offre
        // (`GIT_ITEMS_PROVIDER`) : Projets ne lit pas sa table, et dégrade
        // proprement quand le module est absent.
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
    access: WRITE,
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
