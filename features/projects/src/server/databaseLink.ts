import { projectDatabaseLink, projectDatabaseList, projectDatabaseUnlink } from '../contracts/commands';
import { DATABASE_ITEMS_PROVIDER, type DatabaseItemsProvider } from '@deveye/types/sdk';
import { defineSdkFeature, FeatureError } from '@deveye/types/sdk/server';

import { loadProject, WRITE, type Ctx } from './_shared';

/**
 * Le pointeur d'un projet vers des bases de données.
 *
 * Exactement la même forme que `repoLink.ts` pour les dépôts git, et pour les
 * mêmes raisons : la base appartient à l'espace, le projet n'en garde qu'une
 * liaison, et supprimer l'un ne supprime jamais l'autre.
 *
 * Gardé sous `projects: write` : c'est le projet qu'on modifie ici, pas la base.
 * Lire le détail d'une base relève, lui, du droit `database`.
 *
 * La table de liaison (`project_database_links`) est celle de Projets, lue par
 * `ctx.repo.links` à côté des services surveillés : Projets ne lit pas la
 * table des bases, et ne les connaît que par le contrat que le module Bases de
 * données offre.
 */

export const projectDatabaseListFeature = defineSdkFeature({
    ...projectDatabaseList,
    handler: async (ctx: Ctx, input) => {
        await loadProject(ctx, input.projectId);
        return { databaseIds: await ctx.repo.links.listDatabaseIds(input.projectId, ctx.workspaceId) };
    }
});

export const projectDatabaseLinkFeature = defineSdkFeature({
    ...projectDatabaseLink,
    mutates: ['projects', 'database'],
    access: WRITE,
    handler: async (ctx: Ctx, input) => {
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
        // autre espace, dont l'existence même n'a pas à fuiter. On ne vérifie
        // que l'existence : le **droit** de l'ouvrir reste celui de Bases de
        // données, vérifié au moment où on l'ouvre.
        //
        // La question passe par le contrat que le module Bases de données offre
        // (`DATABASE_ITEMS_PROVIDER`) : Projets ne lit pas sa table, et dégrade
        // proprement quand le module est absent.
        const databases = ctx.providers.get<DatabaseItemsProvider>(DATABASE_ITEMS_PROVIDER);
        if (!databases) throw new FeatureError('validation', 'Le module Bases de données n’est pas installé.');
        if (!(await databases.exists(input.databaseId, ctx.workspaceId))) {
            throw new FeatureError('not_found', 'Cette base n’existe pas dans cet espace.');
        }

        await ctx.repo.links.linkDatabase(input.projectId, ctx.workspaceId, input.databaseId);
        return { databaseIds: await ctx.repo.links.listDatabaseIds(input.projectId, ctx.workspaceId) };
    }
});

export const projectDatabaseUnlinkFeature = defineSdkFeature({
    ...projectDatabaseUnlink,
    mutates: ['projects', 'database'],
    access: WRITE,
    handler: async (ctx: Ctx, input) => {
        await loadProject(ctx, input.projectId);
        // La base elle-même n'est pas touchée : seule la liaison tombe.
        await ctx.repo.links.unlinkDatabase(input.projectId, ctx.workspaceId, input.databaseId);
        return { databaseIds: await ctx.repo.links.listDatabaseIds(input.projectId, ctx.workspaceId) };
    }
});

export const projectDatabaseLinkFeatures = [
    projectDatabaseListFeature,
    projectDatabaseLinkFeature,
    projectDatabaseUnlinkFeature
];
