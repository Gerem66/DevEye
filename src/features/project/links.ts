import { projectLinkAdd, projectLinkList, projectLinkRemove, projectMyTasks } from 'deveye-types';
import type { MyTask, ProjectLink, ProjectLinkRow, ProjectRow } from 'deveye-types';
import { defineFeature, FeatureError, type FeatureContext, type FeatureDefinition } from '../_define';
import { cipherFor, decryptCard, loadProject, toCard, tryDecryptProject } from './_shared';

/**
 * Le transverse : mes tâches à travers tous les projets, et les liens d'un
 * projet vers le reste de DevEye.
 *
 * Les deux répondent à la même question posée dans les deux sens — « qu'est-ce
 * qui touche ce projet ? » et « qu'est-ce qui me touche, moi, dans tous les
 * projets ? » — d'où leur cohabitation dans ce fichier.
 */

const READ = { feature: 'projects' } as const;
const WRITE = { feature: 'projects', level: 'write' } as const;

function toLink(row: ProjectLinkRow): ProjectLink {
    return {
        id: row.id,
        projectId: row.project_id,
        kind: row.kind === 'device' || row.kind === 'note' ? row.kind : 'uptime',
        targetId: row.target_id,
        created: row.created
    };
}

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

export const projectLinkListFeature: FeatureDefinition<
    typeof projectLinkList.command,
    typeof projectLinkList.input,
    typeof projectLinkList.output
> = defineFeature({
    ...projectLinkList,
    access: READ,
    handler: async (ctx, input) => {
        await loadProject(ctx, input.projectId);
        const rows = await ctx.db.projectLinks.listByProject(input.projectId, ctx.workspaceId);
        return { links: rows.map(toLink) };
    }
});

/**
 * La cible existe-t-elle, et dans **cet** espace ?
 *
 * Sans cette garde, on pourrait rattacher n'importe quel identifiant — y compris
 * celui d'un objet d'un autre espace, dont l'existence même n'a pas à fuiter.
 * On ne vérifie que l'existence : le **droit** de l'ouvrir reste celui de la
 * feature cible, vérifié au moment où on l'ouvre.
 */
async function assertTargetExists(ctx: FeatureContext, kind: string, targetId: string): Promise<void> {
    if (kind === 'uptime' || kind === 'note') {
        const id = Number(targetId);
        if (!Number.isInteger(id) || id <= 0) throw new FeatureError('validation', 'Identifiant de cible invalide.');
        const found =
            kind === 'uptime'
                ? await ctx.db.uptimeServices.findById(id, ctx.workspaceId)
                : await ctx.db.notes.findById(id, ctx.workspaceId);
        if (!found) throw new FeatureError('not_found', 'Cette cible n’existe pas dans cet espace.');
        return;
    }
    // L'identifiant d'un appareil est déjà une chaîne (son UUID) : pas de
    // conversion, contrairement aux deux cas ci-dessus.
    const device = await ctx.db.devices.findById(targetId);
    if (!device || device.workspace_id !== ctx.workspaceId) {
        throw new FeatureError('not_found', 'Cet appareil n’existe pas dans cet espace.');
    }
}

export const projectLinkAddFeature: FeatureDefinition<
    typeof projectLinkAdd.command,
    typeof projectLinkAdd.input,
    typeof projectLinkAdd.output
> = defineFeature({
    ...projectLinkAdd,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        await loadProject(ctx, input.projectId);
        await assertTargetExists(ctx, input.kind, input.targetId);
        const row = await ctx.db.projectLinks.create({
            projectId: input.projectId,
            workspaceId: ctx.workspaceId,
            kind: input.kind,
            targetId: input.targetId
        });
        return { link: toLink(row) };
    }
});

export const projectLinkRemoveFeature: FeatureDefinition<
    typeof projectLinkRemove.command,
    typeof projectLinkRemove.input,
    typeof projectLinkRemove.output
> = defineFeature({
    ...projectLinkRemove,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        const ok = await ctx.db.projectLinks.delete(input.linkId, ctx.workspaceId);
        if (!ok) throw new FeatureError('not_found', 'Lien introuvable');
        return { linkId: input.linkId };
    }
});

export const projectLinkFeatures = [
    projectMyTasksFeature,
    projectLinkListFeature,
    projectLinkAddFeature,
    projectLinkRemoveFeature
];
