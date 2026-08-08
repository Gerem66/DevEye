import { projectDatabaseLink, projectDatabaseList, projectDatabaseUnlink } from 'deveye-types';
import { defineFeature, FeatureError, type FeatureDefinition } from '../_define';
import { loadProject } from './_shared';

/**
 * Le pointeur d'un projet vers des bases de données.
 *
 * Exactement la même forme que `repoLink.ts` pour les dépôts git, et pour les
 * mêmes raisons : la base appartient à l'espace, le projet n'en garde qu'une
 * liaison, et supprimer l'un ne supprime jamais l'autre. Une seule différence —
 * un projet peut suivre **plusieurs** bases, là où il n'a qu'un dépôt.
 *
 * Gardé sous `projects: write` : c'est le projet qu'on modifie ici, pas la base.
 * Lire le détail d'une base relève, lui, du droit `database`.
 */

const READ = { feature: 'projects' } as const;
const WRITE = { feature: 'projects', level: 'write' } as const;

export const projectDatabaseListFeature: FeatureDefinition<
    typeof projectDatabaseList.command,
    typeof projectDatabaseList.input,
    typeof projectDatabaseList.output
> = defineFeature({
    ...projectDatabaseList,
    access: READ,
    handler: async (ctx, input) => {
        await loadProject(ctx, input.projectId);
        return { databaseIds: await ctx.db.databases.listLinkedIds(input.projectId, ctx.workspaceId) };
    }
});

export const projectDatabaseLinkFeature: FeatureDefinition<
    typeof projectDatabaseLink.command,
    typeof projectDatabaseLink.input,
    typeof projectDatabaseLink.output
> = defineFeature({
    ...projectDatabaseLink,
    mutates: ['projects', 'database'],
    access: WRITE,
    handler: async (ctx, input) => {
        const project = await loadProject(ctx, input.projectId);

        // Un projet confidentiel ne peut pas être lié : la liaison est une ligne
        // en clair, la base vit à l'étage ouvert, et le relevé périodique tourne
        // sans session. Accepter la liaison reviendrait à promettre une
        // confidentialité qu'on ne tient pas.
        if (project.security_tier === 'guarded') {
            throw new FeatureError(
                'validation',
                'Un projet confidentiel ne peut pas être relié à une base de données.'
            );
        }

        // La base existe-t-elle, et dans **cet** espace ? Sans cette garde on
        // lierait n'importe quel identifiant, y compris celui d'une base d'un
        // autre espace — dont l'existence même n'a pas à fuiter.
        const database = await ctx.db.databases.find(input.databaseId, ctx.workspaceId);
        if (!database) throw new FeatureError('not_found', 'Cette base n’existe pas dans cet espace.');

        await ctx.db.databases.link(input.projectId, ctx.workspaceId, input.databaseId);
        return { databaseIds: await ctx.db.databases.listLinkedIds(input.projectId, ctx.workspaceId) };
    }
});

export const projectDatabaseUnlinkFeature: FeatureDefinition<
    typeof projectDatabaseUnlink.command,
    typeof projectDatabaseUnlink.input,
    typeof projectDatabaseUnlink.output
> = defineFeature({
    ...projectDatabaseUnlink,
    mutates: ['projects', 'database'],
    access: WRITE,
    handler: async (ctx, input) => {
        await loadProject(ctx, input.projectId);
        // La base elle-même n'est pas touchée : seule la liaison tombe.
        await ctx.db.databases.unlink(input.projectId, ctx.workspaceId, input.databaseId);
        return { databaseIds: await ctx.db.databases.listLinkedIds(input.projectId, ctx.workspaceId) };
    }
});

export const projectDatabaseLinkFeatures = [
    projectDatabaseListFeature,
    projectDatabaseLinkFeature,
    projectDatabaseUnlinkFeature
];
