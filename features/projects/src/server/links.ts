import {
    projectLinkCounts,
    projectMyTasks,
    projectUptimeLink,
    projectUptimeList,
    projectUptimeUnlink
} from '../contracts/commands';
import type { MyTask, ProjectRow } from '../contracts/domain';
import { UPTIME_ITEMS_PROVIDER, type UptimeItemsProvider } from '@deveye/types/sdk';
import { defineSdkFeature, FeatureError } from '@deveye/types/sdk/server';

import { cipherFor, decryptCard, loadProject, toCard, tryDecryptProject, WRITE, type Ctx } from './_shared';

/**
 * Le transverse : mes tâches à travers tous les projets, et les services
 * surveillés qu'un projet rattache.
 *
 * Les deux répondent à la même question posée dans les deux sens (« qu'est-ce
 * qui touche ce projet ? » et « qu'est-ce qui me touche, moi, dans tous les
 * projets ? »), d'où leur cohabitation dans ce fichier.
 */

export const projectMyTasksFeature = defineSdkFeature({
    ...projectMyTasks,
    handler: async (ctx: Ctx) => {
        const rows = await ctx.repo.board.listAssignedTo(ctx.workspaceId, ctx.userId);
        if (rows.length === 0) return { tasks: [] };

        // Les projets concernés, chargés une fois : une même carte par projet
        // n'a pas à provoquer une lecture de projet par carte.
        const projectIds = [...new Set(rows.map((r) => r.project_id))];
        const projects = new Map<number, ProjectRow>();
        for (const id of projectIds) {
            const row = await ctx.repo.projects.findById(id, ctx.workspaceId);
            if (row) projects.set(id, row);
        }

        // Un projet gardé n'est lisible que si la session l'est déjà. On ne le
        // demande qu'une fois, et seulement s'il y a vraiment du gardé en jeu :
        // interroger le coffre fait glisser la fenêtre de grâce.
        const anyGuarded = [...projects.values()].some((p) => p.security_tier === 'guarded');
        const canReadGuarded = anyGuarded ? await ctx.secrecy.isUnlocked() : false;

        const tasks: MyTask[] = [];
        for (const row of rows) {
            const project = projects.get(row.project_id);
            if (!project) continue;

            const guarded = project.security_tier === 'guarded';
            const masked = guarded && !canReadGuarded;
            const cipher = cipherFor(ctx, project.security_tier);

            // Masqué plutôt qu'absent : une liste de tâches incomplète serait
            // pire qu'une liste qui dit ce qu'elle ne peut pas lire.
            const payload = masked
                ? { title: '', description: '', checklist: [] }
                : await decryptCard(cipher, row.content);
            const projectBody = masked ? null : await tryDecryptProject(cipher, project.content);

            tasks.push({
                card: toCard(row, payload, 0),
                projectId: project.id,
                projectTitle: projectBody?.title ?? '',
                masked
            });
        }
        return { tasks };
    }
});

export const projectLinkCountsFeature = defineSdkFeature({
    ...projectLinkCounts,
    handler: async (ctx: Ctx, input) => {
        await loadProject(ctx, input.projectId);
        // Les listes plutôt que quatre `COUNT(*)` : ce sont des poignées
        // d'identifiants, les requêtes existent déjà et sont celles que les
        // onglets eux-mêmes appellent. Une seconde famille de requêtes pour
        // rendre le même fait ne se serait payée qu'en occasions de diverger.
        const [repos, databases, sites, targets, services] = await Promise.all([
            ctx.repo.links.listRepoIds(input.projectId, ctx.workspaceId),
            ctx.repo.links.listDatabaseIds(input.projectId, ctx.workspaceId),
            ctx.repo.links.listSiteIds(input.projectId, ctx.workspaceId),
            ctx.repo.links.listDeployTargetIds(input.projectId, ctx.workspaceId),
            ctx.repo.links.listServiceIds(input.projectId, ctx.workspaceId)
        ]);
        return {
            counts: {
                git: repos.length,
                database: databases.length,
                audience: sites.length,
                // L'onglet Déploiement montre deux choses : les cibles reliées
                // et les services surveillés. Il a donc de quoi s'ouvrir dès que
                // l'une des deux existe.
                deploy: targets.length + services.length
            }
        };
    }
});

export const projectUptimeListFeature = defineSdkFeature({
    ...projectUptimeList,
    handler: async (ctx: Ctx, input) => {
        await loadProject(ctx, input.projectId);
        return { serviceIds: await ctx.repo.links.listServiceIds(input.projectId, ctx.workspaceId) };
    }
});

export const projectUptimeLinkFeature = defineSdkFeature({
    ...projectUptimeLink,
    mutates: true,
    access: WRITE,
    handler: async (ctx: Ctx, input) => {
        await loadProject(ctx, input.projectId);
        // La cible existe-t-elle, et dans **cet** espace ? Sans cette garde on
        // rattacherait n'importe quel identifiant, y compris celui d'un service
        // d'un autre espace, dont l'existence même n'a pas à fuiter. On ne
        // vérifie que l'existence : le **droit** de l'ouvrir reste celui
        // d'Uptime, vérifié au moment où on l'ouvre.
        //
        // La question passe par le contrat que le module Uptime offre
        // (`UPTIME_ITEMS_PROVIDER`, lu par `ctx.providers`) : Projets ne lit
        // pas sa table, et dégrade proprement quand le module est absent.
        const uptime = ctx.providers.get<UptimeItemsProvider>(UPTIME_ITEMS_PROVIDER);
        if (!uptime) throw new FeatureError('validation', 'Le module Uptime n’est pas installé.');
        if (!(await uptime.exists(input.serviceId, ctx.workspaceId))) {
            throw new FeatureError('not_found', 'Ce service n’existe pas dans cet espace.');
        }
        await ctx.repo.links.link(input.projectId, ctx.workspaceId, input.serviceId);
        return { serviceIds: await ctx.repo.links.listServiceIds(input.projectId, ctx.workspaceId) };
    }
});

export const projectUptimeUnlinkFeature = defineSdkFeature({
    ...projectUptimeUnlink,
    mutates: true,
    access: WRITE,
    handler: async (ctx: Ctx, input) => {
        await loadProject(ctx, input.projectId);
        // Le service lui-même n'est pas touché : seule la liaison tombe.
        await ctx.repo.links.unlink(input.projectId, ctx.workspaceId, input.serviceId);
        return { serviceIds: await ctx.repo.links.listServiceIds(input.projectId, ctx.workspaceId) };
    }
});

export const projectLinkFeatures = [
    projectMyTasksFeature,
    projectLinkCountsFeature,
    projectUptimeListFeature,
    projectUptimeLinkFeature,
    projectUptimeUnlinkFeature
];
