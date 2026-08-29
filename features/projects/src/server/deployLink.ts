import { projectDeployLink, projectDeployList, projectDeployUnlink } from '../contracts/commands';
import { DEPLOY_ITEMS_PROVIDER, type DeployItemsProvider } from '@deveye/types/sdk';
import { defineSdkFeature, FeatureError } from '@deveye/types/sdk/server';

import { assertAtHome, linkLabels, loadProject, recordEvent, WRITE, type Ctx } from './_shared';

/**
 * Le pointeur d'un projet vers les cibles de déploiement de l'espace, même forme que
 * `repoLink.ts` : la cible vit dans la feature Déploiement, qui porte sa clé, son
 * historique et son suivi d'état, et la liaison est non exclusive dans les deux sens.
 *
 * Gardé sous `projects: write` : c'est le projet qu'on modifie ici, pas la cible.
 * Lire son historique, et surtout déclencher, relève du droit `deploy`.
 */

export const projectDeployListFeature = defineSdkFeature({
    ...projectDeployList,
    handler: async (ctx: Ctx, input) => {
        const project = await loadProject(ctx, input.projectId);
        const targetIds = await ctx.repo.links.listDeployTargetIds(input.projectId, project.workspace_id);
        const targets = ctx.providers.get<DeployItemsProvider>(DEPLOY_ITEMS_PROVIDER);
        return { targetIds, labels: await linkLabels(targets, targetIds, project.workspace_id) };
    }
});

export const projectDeployLinkFeature = defineSdkFeature({
    ...projectDeployLink,
    mutates: ['projects', 'deploy'],
    access: WRITE,
    handler: async (ctx: Ctx, input) => {
        const project = await loadProject(ctx, input.projectId, 'write');
        assertAtHome(ctx, project, 'relier une cible de déploiement');

        // La liaison est une ligne en clair, la cible vit à l'étage ouvert et son
        // suivi tourne sans session : même refus que pour un dépôt.
        if (project.security_tier === 'guarded') {
            throw new FeatureError(
                'validation',
                'Un projet confidentiel ne peut pas être relié à un déploiement : le suivi tourne sans session.'
            );
        }

        // Seule l'existence est vérifiée, et par le contrat qu'offre le module : le
        // droit de déclencher reste celui de Déploiement, vérifié au déclenchement.
        const targets = ctx.providers.get<DeployItemsProvider>(DEPLOY_ITEMS_PROVIDER);
        if (!targets) throw new FeatureError('validation', 'Le module Déploiements n’est pas installé.');
        if (!(await targets.exists(input.targetId, project.workspace_id))) {
            throw new FeatureError('not_found', 'Cette cible n’existe pas dans cet espace.');
        }

        await ctx.repo.links.linkDeployTarget(input.projectId, project.workspace_id, input.targetId);
        await recordEvent(ctx, project, { kind: 'projects.deployLink', label: 'Cible de déploiement reliée' });
        ctx.audit({
            action: 'projects.deployLink',
            description: 'Cible de déploiement reliée au projet',
            metadata: { projectId: input.projectId, targetId: input.targetId }
        });
        return { targetIds: await ctx.repo.links.listDeployTargetIds(input.projectId, project.workspace_id) };
    }
});

export const projectDeployUnlinkFeature = defineSdkFeature({
    ...projectDeployUnlink,
    mutates: ['projects', 'deploy'],
    access: WRITE,
    handler: async (ctx: Ctx, input) => {
        const project = await loadProject(ctx, input.projectId, 'write');
        assertAtHome(ctx, project, 'délier une cible de déploiement');
        // La cible et son historique survivent : d'autres projets s'en servent.
        const ok = await ctx.repo.links.unlinkDeployTarget(input.projectId, project.workspace_id, input.targetId);
        if (ok)
            await recordEvent(ctx, project, { kind: 'projects.deployUnlink', label: 'Cible de déploiement déliée' });
        return { targetIds: await ctx.repo.links.listDeployTargetIds(input.projectId, project.workspace_id) };
    }
});

export const projectDeployLinkFeatures = [
    projectDeployListFeature,
    projectDeployLinkFeature,
    projectDeployUnlinkFeature
];
