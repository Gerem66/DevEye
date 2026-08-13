import { projectDeployLink, projectDeployList, projectDeployUnlink } from 'deveye-types';
import { defineFeature, FeatureError, type FeatureDefinition } from '../_define';
import { loadProject, recordEvent } from './_shared';

/**
 * Le pointeur d'un projet vers les cibles de déploiement de l'espace.
 *
 * Trois commandes seulement : **la cible n'appartient pas au projet.** Elle vit
 * dans la feature Déploiement, qui porte sa clé, son historique et son suivi
 * d'état. Ce qui suit ne fait que poser et retirer un pointeur — d'où le fait
 * que tout y soit un `targetId` et rien d'autre.
 *
 * Cinquième liaison de la même famille, après les services surveillés, les
 * bases, les dépôts et les sites suivis. Non exclusive dans les deux sens : un
 * projet déploie parfois deux cibles (une application et sa base), et une pile
 * compose sert souvent deux projets.
 *
 * Gardé sous `projects: write` : c'est le projet qu'on modifie ici, pas la
 * cible. Lire son historique — et surtout **déclencher** — relève du droit
 * `deploy`.
 */

const READ = { feature: 'projects' } as const;
const WRITE = { feature: 'projects', level: 'write' } as const;

export const projectDeployListFeature: FeatureDefinition<
    typeof projectDeployList.command,
    typeof projectDeployList.input,
    typeof projectDeployList.output
> = defineFeature({
    ...projectDeployList,
    access: READ,
    handler: async (ctx, input) => {
        await loadProject(ctx, input.projectId);
        return { targetIds: await ctx.db.deploy.listLinkedTargetIds(input.projectId, ctx.workspaceId) };
    }
});

export const projectDeployLinkFeature: FeatureDefinition<
    typeof projectDeployLink.command,
    typeof projectDeployLink.input,
    typeof projectDeployLink.output
> = defineFeature({
    ...projectDeployLink,
    mutates: ['projects', 'deploy'],
    access: WRITE,
    handler: async (ctx, input) => {
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
        const target = await ctx.db.deploy.findTarget(input.targetId, ctx.workspaceId);
        if (!target) throw new FeatureError('not_found', 'Cette cible n’existe pas dans cet espace.');

        await ctx.db.deploy.linkProject(input.projectId, ctx.workspaceId, input.targetId);
        await recordEvent(ctx, project, { kind: 'project.deployLink', label: 'Cible de déploiement reliée' });
        ctx.audit({
            action: 'project.deployLink',
            description: 'Cible de déploiement reliée au projet',
            metadata: { projectId: input.projectId, targetId: input.targetId }
        });
        return { targetIds: await ctx.db.deploy.listLinkedTargetIds(input.projectId, ctx.workspaceId) };
    }
});

export const projectDeployUnlinkFeature: FeatureDefinition<
    typeof projectDeployUnlink.command,
    typeof projectDeployUnlink.input,
    typeof projectDeployUnlink.output
> = defineFeature({
    ...projectDeployUnlink,
    mutates: ['projects', 'deploy'],
    access: WRITE,
    handler: async (ctx, input) => {
        const project = await loadProject(ctx, input.projectId);
        // La cible et son historique survivent : ils appartiennent à l'espace,
        // et d'autres projets peuvent s'en servir.
        const ok = await ctx.db.deploy.unlinkProject(input.projectId, ctx.workspaceId, input.targetId);
        if (ok) await recordEvent(ctx, project, { kind: 'project.deployUnlink', label: 'Cible de déploiement déliée' });
        return { targetIds: await ctx.db.deploy.listLinkedTargetIds(input.projectId, ctx.workspaceId) };
    }
});

export const projectDeployLinkFeatures = [
    projectDeployListFeature,
    projectDeployLinkFeature,
    projectDeployUnlinkFeature
];
