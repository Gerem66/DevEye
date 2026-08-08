import { projectRepoGet, projectRepoLink, projectRepoUnlink } from 'deveye-types';
import { defineFeature, FeatureError, type FeatureDefinition } from '../_define';
import { assertProjectUnlocked, loadProject, recordEvent } from './_shared';

/**
 * La liaison d'un projet vers un dépôt de l'espace.
 *
 * Trois commandes, et rien d'autre : **le dépôt n'appartient pas au projet.**
 * Il vit dans la feature Git (`src/features/git/`), qui porte son cache, sa
 * synchronisation et ses jetons — et qui est aussi la seule à pouvoir les lire
 * (`{ feature: 'git' }`). Ce qui suit ne pose et ne retire qu'un pointeur, sous
 * le droit du projet.
 *
 * Conséquence voulue : délier un dépôt d'un projet ne détruit rien. Le dépôt,
 * son historique et les autres projets qui s'en servent ne bougent pas.
 */

const WRITE = { feature: 'projects', level: 'write' } as const;
const READ = { feature: 'projects' } as const;

export const projectRepoGetFeature: FeatureDefinition<
    typeof projectRepoGet.command,
    typeof projectRepoGet.input,
    typeof projectRepoGet.output
> = defineFeature({
    ...projectRepoGet,
    access: READ,
    handler: async (ctx, input) => {
        await loadProject(ctx, input.projectId);
        const link = await ctx.db.git.findLink(input.projectId, ctx.workspaceId);
        return { repoId: link?.repo_id ?? null };
    }
});

export const projectRepoLinkFeature: FeatureDefinition<
    typeof projectRepoLink.command,
    typeof projectRepoLink.input,
    typeof projectRepoLink.output
> = defineFeature({
    ...projectRepoLink,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        const project = await loadProject(ctx, input.projectId);
        await assertProjectUnlocked(ctx, project);

        // Un projet confidentiel ne se lie pas. Deux raisons qui vont dans le
        // même sens : le service de fond tourne sans session et n'atteindra
        // jamais l'étage gardé ; et la liaison elle-même est une ligne en clair,
        // qui rattacherait un projet confidentiel à un dépôt nommé — c'est
        // exactement ce que le palier est censé ne pas laisser voir.
        if (project.security_tier === 'guarded') {
            throw new FeatureError(
                'validation',
                'Un projet confidentiel ne peut pas être relié à un dépôt : la liaison serait visible en clair, ' +
                    'et la synchronisation tourne sans session.'
            );
        }

        // La frontière d'espace : sans elle, on lierait le dépôt d'un autre.
        const repo = await ctx.db.git.findRepo(input.repoId, ctx.workspaceId);
        if (!repo) throw new FeatureError('not_found', 'Dépôt introuvable');

        await ctx.db.git.linkProject(input.projectId, ctx.workspaceId, input.repoId);
        await recordEvent(ctx, project, { kind: 'project.repoLink', label: 'Dépôt git relié' });
        ctx.audit({
            action: 'project.repoLink',
            description: 'Dépôt relié au projet',
            metadata: { projectId: input.projectId, repoId: input.repoId }
        });
        return { repoId: input.repoId };
    }
});

export const projectRepoUnlinkFeature: FeatureDefinition<
    typeof projectRepoUnlink.command,
    typeof projectRepoUnlink.input,
    typeof projectRepoUnlink.output
> = defineFeature({
    ...projectRepoUnlink,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        const project = await loadProject(ctx, input.projectId);
        await assertProjectUnlocked(ctx, project);
        const ok = await ctx.db.git.unlinkProject(input.projectId, ctx.workspaceId);
        if (!ok) throw new FeatureError('not_found', 'Aucun dépôt lié');
        await recordEvent(ctx, project, { kind: 'project.repoUnlink', label: 'Dépôt git délié' });
        return { projectId: input.projectId };
    }
});

export const projectRepoLinkFeatures = [projectRepoGetFeature, projectRepoLinkFeature, projectRepoUnlinkFeature];
