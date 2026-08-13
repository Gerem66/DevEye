import {
    projectLinkCounts,
    projectMyTasks,
    projectUptimeLink,
    projectUptimeList,
    projectUptimeUnlink
} from 'deveye-types';
import type { MyTask, ProjectRow } from 'deveye-types';
import { defineFeature, FeatureError, type FeatureDefinition } from '../_define';
import { cipherFor, decryptCard, loadProject, toCard, tryDecryptProject } from './_shared';

/**
 * Le transverse : mes tâches à travers tous les projets, et les services
 * surveillés qu'un projet rattache.
 *
 * Les deux répondent à la même question posée dans les deux sens — « qu'est-ce
 * qui touche ce projet ? » et « qu'est-ce qui me touche, moi, dans tous les
 * projets ? » — d'où leur cohabitation dans ce fichier.
 */

const READ = { feature: 'projects' } as const;
const WRITE = { feature: 'projects', level: 'write' } as const;

export const projectMyTasksFeature: FeatureDefinition<
    typeof projectMyTasks.command,
    typeof projectMyTasks.input,
    typeof projectMyTasks.output
> = defineFeature({
    ...projectMyTasks,
    access: READ,
    handler: async (ctx) => {
        const rows = await ctx.db.projectBoard.listAssignedTo(ctx.workspaceId, ctx.userId);
        if (rows.length === 0) return { tasks: [] };

        // Les projets concernés, chargés une fois : une même carte par projet
        // n'a pas à provoquer une lecture de projet par carte.
        const projectIds = [...new Set(rows.map((r) => r.project_id))];
        const projects = new Map<number, ProjectRow>();
        for (const id of projectIds) {
            const row = await ctx.db.projects.findById(id, ctx.workspaceId);
            if (row) projects.set(id, row);
        }

        // Un projet gardé n'est lisible que si la session l'est déjà. On ne le
        // demande qu'une fois, et seulement s'il y a vraiment du gardé en jeu —
        // interroger le coffre fait glisser la fenêtre de grâce.
        const anyGuarded = [...projects.values()].some((p) => p.security_tier === 'guarded');
        const canReadGuarded = anyGuarded ? await ctx.secure.isUnlocked() : false;

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

export const projectLinkCountsFeature: FeatureDefinition<
    typeof projectLinkCounts.command,
    typeof projectLinkCounts.input,
    typeof projectLinkCounts.output
> = defineFeature({
    ...projectLinkCounts,
    access: READ,
    handler: async (ctx, input) => {
        await loadProject(ctx, input.projectId);
        // Les listes plutôt que quatre `COUNT(*)` : ce sont des poignées
        // d'identifiants, les requêtes existent déjà et sont celles que les
        // onglets eux-mêmes appellent. Une seconde famille de requêtes pour
        // rendre le même fait ne se serait payée qu'en occasions de diverger.
        const [repos, databases, sites, targets, services] = await Promise.all([
            ctx.db.git.listLinkedRepoIds(input.projectId, ctx.workspaceId),
            ctx.db.databases.listLinkedIds(input.projectId, ctx.workspaceId),
            ctx.db.audience.listLinkedIds(input.projectId, ctx.workspaceId),
            ctx.db.deploy.listLinkedTargetIds(input.projectId, ctx.workspaceId),
            ctx.db.projectLinks.listServiceIds(input.projectId, ctx.workspaceId)
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

export const projectUptimeListFeature: FeatureDefinition<
    typeof projectUptimeList.command,
    typeof projectUptimeList.input,
    typeof projectUptimeList.output
> = defineFeature({
    ...projectUptimeList,
    access: READ,
    handler: async (ctx, input) => {
        await loadProject(ctx, input.projectId);
        return { serviceIds: await ctx.db.projectLinks.listServiceIds(input.projectId, ctx.workspaceId) };
    }
});

export const projectUptimeLinkFeature: FeatureDefinition<
    typeof projectUptimeLink.command,
    typeof projectUptimeLink.input,
    typeof projectUptimeLink.output
> = defineFeature({
    ...projectUptimeLink,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        await loadProject(ctx, input.projectId);
        // La cible existe-t-elle, et dans **cet** espace ? Sans cette garde on
        // rattacherait n'importe quel identifiant, y compris celui d'un service
        // d'un autre espace — dont l'existence même n'a pas à fuiter. On ne
        // vérifie que l'existence : le **droit** de l'ouvrir reste celui
        // d'Uptime, vérifié au moment où on l'ouvre.
        const service = await ctx.db.uptimeServices.findById(input.serviceId, ctx.workspaceId);
        if (!service) throw new FeatureError('not_found', 'Ce service n’existe pas dans cet espace.');
        await ctx.db.projectLinks.link(input.projectId, ctx.workspaceId, input.serviceId);
        return { serviceIds: await ctx.db.projectLinks.listServiceIds(input.projectId, ctx.workspaceId) };
    }
});

export const projectUptimeUnlinkFeature: FeatureDefinition<
    typeof projectUptimeUnlink.command,
    typeof projectUptimeUnlink.input,
    typeof projectUptimeUnlink.output
> = defineFeature({
    ...projectUptimeUnlink,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        await loadProject(ctx, input.projectId);
        // Le service lui-même n'est pas touché : seule la liaison tombe.
        await ctx.db.projectLinks.unlink(input.projectId, ctx.workspaceId, input.serviceId);
        return { serviceIds: await ctx.db.projectLinks.listServiceIds(input.projectId, ctx.workspaceId) };
    }
});

export const projectLinkFeatures = [
    projectMyTasksFeature,
    projectLinkCountsFeature,
    projectUptimeListFeature,
    projectUptimeLinkFeature,
    projectUptimeUnlinkFeature
];
