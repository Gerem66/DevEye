import { projectDatabaseLink, projectDatabaseList, projectDatabaseUnlink } from '../contracts/commands';
import { DATABASE_ITEMS_PROVIDER, type DatabaseItemsProvider } from '@deveye/types/sdk';
import { defineSdkFeature, FeatureError } from '@deveye/types/sdk/server';

import { assertAtHome, linkLabels, loadProject, WRITE, type Ctx } from './_shared';

/**
 * Le pointeur d'un projet vers des bases de données, même forme que `repoLink.ts` :
 * la base appartient à l'espace, le projet n'en garde qu'une liaison, et supprimer
 * l'un ne supprime jamais l'autre. Gardé sous `projects: write` : c'est le projet
 * qu'on modifie ici, le détail d'une base relevant du droit `database`.
 */

export const projectDatabaseListFeature = defineSdkFeature({
    ...projectDatabaseList,
    handler: async (ctx: Ctx, input) => {
        const project = await loadProject(ctx, input.projectId);
        const databaseIds = await ctx.repo.links.listDatabaseIds(input.projectId, project.workspace_id);
        const databases = ctx.providers.get<DatabaseItemsProvider>(DATABASE_ITEMS_PROVIDER);
        return { databaseIds, labels: await linkLabels(databases, databaseIds, project.workspace_id) };
    }
});

export const projectDatabaseLinkFeature = defineSdkFeature({
    ...projectDatabaseLink,
    mutates: ['projects', 'database'],
    access: WRITE,
    handler: async (ctx: Ctx, input) => {
        const project = await loadProject(ctx, input.projectId, 'write');
        assertAtHome(ctx, project, 'relier une base de données');

        // La liaison est une ligne en clair, la base vit à l'étage ouvert et son
        // relevé périodique tourne sans session : même refus que pour un dépôt.
        if (project.security_tier === 'guarded') {
            throw new FeatureError(
                'validation',
                'Un projet confidentiel ne peut pas être relié à une base de données.'
            );
        }

        // Seule la visibilité d'ici (chez elle ou projetée) est vérifiée, et par le
        // contrat qu'offre le module : le droit d'ouvrir la base reste celui de Bases
        // de données. Sans cette garde on lierait l'identifiant d'une base d'un
        // espace qui ne partage rien ici, dont l'existence n'a pas à fuiter.
        const databases = ctx.providers.get<DatabaseItemsProvider>(DATABASE_ITEMS_PROVIDER);
        if (!databases) throw new FeatureError('validation', 'Le module Bases de données n’est pas installé.');
        if (!(await databases.exists(input.databaseId, project.workspace_id))) {
            throw new FeatureError('not_found', 'Cette base n’existe pas dans cet espace.');
        }

        await ctx.repo.links.linkDatabase(input.projectId, project.workspace_id, input.databaseId);
        return { databaseIds: await ctx.repo.links.listDatabaseIds(input.projectId, project.workspace_id) };
    }
});

export const projectDatabaseUnlinkFeature = defineSdkFeature({
    ...projectDatabaseUnlink,
    mutates: ['projects', 'database'],
    access: WRITE,
    handler: async (ctx: Ctx, input) => {
        const project = await loadProject(ctx, input.projectId, 'write');
        assertAtHome(ctx, project, 'délier une base de données');
        // La base elle-même n'est pas touchée : seule la liaison tombe.
        await ctx.repo.links.unlinkDatabase(input.projectId, project.workspace_id, input.databaseId);
        return { databaseIds: await ctx.repo.links.listDatabaseIds(input.projectId, project.workspace_id) };
    }
});

export const projectDatabaseLinkFeatures = [
    projectDatabaseListFeature,
    projectDatabaseLinkFeature,
    projectDatabaseUnlinkFeature
];
