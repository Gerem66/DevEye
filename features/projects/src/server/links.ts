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

import {
    assertAtHome,
    decryptCard,
    linkLabels,
    LINKS,
    loadProject,
    projectCipher,
    toCard,
    tryDecryptProject,
    type Ctx
} from './_shared';

/**
 * Le transverse : mes tâches à travers tous les projets, et les services surveillés
 * qu'un projet rattache, la même question posée dans les deux sens. Les liaisons
 * vivent au domicile du projet : depuis une fenêtre elles se lisent, nommées par le
 * contrat d'éléments de la feature visée, mais ne se posent ni ne se retirent
 * (`assertAtHome`).
 */

export const projectMyTasksFeature = defineSdkFeature({
    ...projectMyTasks,
    handler: async (ctx: Ctx) => {
        // Les projets visibles d'ici, projetés compris, moins ceux qu'une
        // restriction masque : une carte d'un projet qu'on ne voit pas n'existe pas.
        const [visible, hidden, scope] = await Promise.all([
            ctx.repo.projects.listVisible(ctx.workspaceId, false),
            ctx.items.restrictions(),
            ctx.sharing.scope()
        ]);
        const projects = new Map<number, ProjectRow>(
            visible.filter((p) => hidden.get(String(p.id)) !== 'none').map((p) => [p.id, p])
        );
        const rows = await ctx.repo.board.listAssignedIn([...projects.keys()], ctx.userId);
        if (rows.length === 0) return { tasks: [] };

        // Un projet gardé n'est lisible que si la session l'est déjà. La question
        // n'est posée qu'une fois, et seulement s'il y a du gardé en jeu :
        // interroger le coffre fait glisser la fenêtre de grâce.
        const concerned = [...new Set(rows.map((r) => r.project_id))].map((id) => projects.get(id));
        const anyGuarded = concerned.some((p) => p?.security_tier === 'guarded');
        const canReadGuarded = anyGuarded ? await ctx.secrecy.isUnlocked() : false;

        const tasks: MyTask[] = [];
        for (const row of rows) {
            const project = projects.get(row.project_id);
            if (!project) continue;

            const guarded = project.security_tier === 'guarded';
            const masked = guarded && !canReadGuarded;
            // Le codec du projet, chez lui : celui d'ici ou celui de son domicile.
            const cipher = await projectCipher(ctx, project, scope);

            // Masqué plutôt qu'absent : une liste de tâches incomplète serait pire
            // qu'une liste qui dit ce qu'elle ne peut pas lire.
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
        const project = await loadProject(ctx, input.projectId);
        const home = project.workspace_id;
        // Les listes plutôt que quatre `COUNT(*)` : des poignées d'identifiants, et
        // les requêtes que les onglets appellent déjà. Une seconde famille pour
        // rendre le même fait ne se paierait qu'en occasions de diverger.
        const [repos, databases, sites, targets, services] = await Promise.all([
            ctx.repo.links.listRepoIds(input.projectId, home),
            ctx.repo.links.listDatabaseIds(input.projectId, home),
            ctx.repo.links.listSiteIds(input.projectId, home),
            ctx.repo.links.listDeployTargetIds(input.projectId, home),
            ctx.repo.links.listServiceIds(input.projectId, home)
        ]);
        return {
            counts: {
                git: repos.length,
                database: databases.length,
                audience: sites.length,
                // L'onglet Déploiement montre les cibles reliées et les services
                // surveillés : il s'ouvre dès que l'un des deux existe.
                deploy: targets.length + services.length
            }
        };
    }
});

export const projectUptimeListFeature = defineSdkFeature({
    ...projectUptimeList,
    handler: async (ctx: Ctx, input) => {
        const project = await loadProject(ctx, input.projectId);
        const serviceIds = await ctx.repo.links.listServiceIds(input.projectId, project.workspace_id);
        // Nommés par le contrat d'Uptime, au domicile du projet : c'est là que les
        // services vivent, et la seule façon pour une fenêtre de les nommer.
        const uptime = ctx.providers.get<UptimeItemsProvider>(UPTIME_ITEMS_PROVIDER);
        return { serviceIds, labels: await linkLabels(uptime, serviceIds, project.workspace_id) };
    }
});

export const projectUptimeLinkFeature = defineSdkFeature({
    ...projectUptimeLink,
    mutates: true,
    access: LINKS,
    handler: async (ctx: Ctx, input) => {
        const project = await loadProject(ctx, input.projectId, 'write');
        assertAtHome(ctx, project, 'relier un service surveillé');
        // Le service est-il visible de cet espace, chez lui ou projeté ? Sans cette
        // garde on rattacherait n'importe quel identifiant, dont celui d'un service
        // d'un espace qui ne partage rien ici, dont l'existence n'a pas à fuiter.
        // Seule la visibilité est vérifiée, le droit de l'ouvrir reste celui
        // d'Uptime. La question passe par le contrat qu'offre le module : Projets
        // ne lit pas sa table, et dégrade proprement quand il est absent.
        const uptime = ctx.providers.get<UptimeItemsProvider>(UPTIME_ITEMS_PROVIDER);
        if (!uptime) throw new FeatureError('validation', 'Le module Uptime n’est pas installé.');
        if (!(await uptime.exists(input.serviceId, project.workspace_id))) {
            throw new FeatureError('not_found', 'Ce service n’existe pas dans cet espace.');
        }
        await ctx.repo.links.link(input.projectId, project.workspace_id, input.serviceId);
        return { serviceIds: await ctx.repo.links.listServiceIds(input.projectId, project.workspace_id) };
    }
});

export const projectUptimeUnlinkFeature = defineSdkFeature({
    ...projectUptimeUnlink,
    mutates: true,
    access: LINKS,
    handler: async (ctx: Ctx, input) => {
        const project = await loadProject(ctx, input.projectId, 'write');
        assertAtHome(ctx, project, 'délier un service surveillé');
        // Le service lui-même n'est pas touché : seule la liaison tombe.
        await ctx.repo.links.unlink(input.projectId, project.workspace_id, input.serviceId);
        return { serviceIds: await ctx.repo.links.listServiceIds(input.projectId, project.workspace_id) };
    }
});

export const projectLinkFeatures = [
    projectMyTasksFeature,
    projectLinkCountsFeature,
    projectUptimeListFeature,
    projectUptimeLinkFeature,
    projectUptimeUnlinkFeature
];
