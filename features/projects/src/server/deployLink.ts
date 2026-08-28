import { projectDeployLink, projectDeployList, projectDeployUnlink } from '../contracts/commands';
import { DEPLOY_ITEMS_PROVIDER, type DeployItemsProvider } from '@deveye/types/sdk';
import { defineSdkFeature, FeatureError } from '@deveye/types/sdk/server';

import { loadProject, recordEvent, WRITE, type Ctx } from './_shared';

/**
 * Le pointeur d'un projet vers les cibles de déploiement de l'espace.
 *
 * Trois commandes seulement : **la cible n'appartient pas au projet.** Elle vit
 * dans la feature Déploiement, qui porte sa clé, son historique et son suivi
 * d'état. Ce qui suit ne fait que poser et retirer un pointeur, d'où le fait
 * que tout y soit un `targetId` et rien d'autre.
 *
 * Cinquième liaison de la même famille, après les services surveillés, les
 * bases, les dépôts et les sites suivis. Non exclusive dans les deux sens : un
 * projet déploie parfois deux cibles (une application et sa base), et une pile
 * compose sert souvent deux projets.
 *
 * Gardé sous `projects: write` : c'est le projet qu'on modifie ici, pas la
 * cible. Lire son historique, et surtout **déclencher**, relève du droit
 * `deploy`.
 *
 * La table de liaison (`project_deploy_links`) est celle de Projets, lue par
 * `ctx.repo.links` : Projets ne lit pas la table des cibles, et ne les connaît
 * que par le contrat que le module Déploiement offre.
 */

export const projectDeployListFeature = defineSdkFeature({
    ...projectDeployList,
    handler: async (ctx: Ctx, input) => {
        await loadProject(ctx, input.projectId);
        return { targetIds: await ctx.repo.links.listDeployTargetIds(input.projectId, ctx.workspaceId) };
    }
});

export const projectDeployLinkFeature = defineSdkFeature({
    ...projectDeployLink,
    mutates: ['projects', 'deploy'],
    access: WRITE,
    handler: async (ctx: Ctx, input) => {
        const project = await loadProject(ctx, input.projectId);

        // Un projet confidentiel ne peut pas être lié : la liaison est une ligne
        // en clair, la cible vit à l'étage ouvert, et le suivi d'état tourne
        // sans session. Accepter reviendrait à promettre une confidentialité
        // qu'on ne tient pas. Même règle que pour un dépôt.
        if (project.security_tier === 'guarded') {
            throw new FeatureError(
                'validation',
                'Un projet confidentiel ne peut pas être relié à un déploiement : le suivi tourne sans session.'
            );
        }

        // La cible existe-t-elle, et dans **cet** espace ? On ne vérifie que
        // l'existence : le **droit** de la déclencher reste celui de la feature
        // Déploiement, vérifié au moment où on déclenche.
        //
        // La question passe par le contrat que le module Déploiement offre
        // (`DEPLOY_ITEMS_PROVIDER`) : Projets ne lit pas sa table, et dégrade
        // proprement quand le module est absent.
        const targets = ctx.providers.get<DeployItemsProvider>(DEPLOY_ITEMS_PROVIDER);
        if (!targets) throw new FeatureError('validation', 'Le module Déploiements n’est pas installé.');
        if (!(await targets.exists(input.targetId, ctx.workspaceId))) {
            throw new FeatureError('not_found', 'Cette cible n’existe pas dans cet espace.');
        }

        await ctx.repo.links.linkDeployTarget(input.projectId, ctx.workspaceId, input.targetId);
        await recordEvent(ctx, project, { kind: 'projects.deployLink', label: 'Cible de déploiement reliée' });
        ctx.audit({
            action: 'projects.deployLink',
            description: 'Cible de déploiement reliée au projet',
            metadata: { projectId: input.projectId, targetId: input.targetId }
        });
        return { targetIds: await ctx.repo.links.listDeployTargetIds(input.projectId, ctx.workspaceId) };
    }
});

export const projectDeployUnlinkFeature = defineSdkFeature({
    ...projectDeployUnlink,
    mutates: ['projects', 'deploy'],
    access: WRITE,
    handler: async (ctx: Ctx, input) => {
        const project = await loadProject(ctx, input.projectId);
        // La cible et son historique survivent : ils appartiennent à l'espace,
        // et d'autres projets peuvent s'en servir.
        const ok = await ctx.repo.links.unlinkDeployTarget(input.projectId, ctx.workspaceId, input.targetId);
        if (ok)
            await recordEvent(ctx, project, { kind: 'projects.deployUnlink', label: 'Cible de déploiement déliée' });
        return { targetIds: await ctx.repo.links.listDeployTargetIds(input.projectId, ctx.workspaceId) };
    }
});

export const projectDeployLinkFeatures = [
    projectDeployListFeature,
    projectDeployLinkFeature,
    projectDeployUnlinkFeature
];
