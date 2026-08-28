import {
    projectCardSetMilestone,
    projectDepAdd,
    projectDepRemove,
    projectMilestoneAdd,
    projectMilestoneRemove,
    projectMilestoneSetReached,
    projectMilestoneUpdate,
    projectPlan
} from '../contracts/commands';
import { projectMilestoneSchema } from '../contracts/domain';
import type { ProjectCardDepRow, ProjectMilestone, ProjectMilestoneRow, ProjectRow } from '../contracts/domain';
import { defineSdkFeature, FeatureError, type SdkCipher } from '@deveye/types/sdk/server';

import { assertProjectUnlocked, cipherFor, loadProject, recordEvent, WRITE, type Ctx } from './_shared';

/**
 * Jalons et dépendances : ce que la frise chronologique lit en plus du tableau.
 *
 * Les dates et le graphe des arêtes vivent en clair : c'est ce qui permet de
 * dessiner la frise, de repérer un retard et de refuser un cycle sans rien
 * déchiffrer. Seul le libellé d'un jalon passe par le chiffre.
 */

interface StoredMilestone {
    name: string;
    description: string;
}

async function encryptMilestone(cipher: SdkCipher, payload: StoredMilestone): Promise<string> {
    return cipher.encrypt(JSON.stringify(payload));
}

/** Ne lève jamais : un jalon illisible reste sur la frise, sans son nom. */
async function decryptMilestone(cipher: SdkCipher, content: string): Promise<StoredMilestone> {
    const plain = await cipher.tryDecrypt(content);
    if (plain === null) return { name: '', description: '' };
    try {
        const parsed = JSON.parse(plain) as Partial<StoredMilestone>;
        return {
            name: typeof parsed.name === 'string' ? parsed.name : '',
            description: typeof parsed.description === 'string' ? parsed.description : ''
        };
    } catch {
        return { name: '', description: '' };
    }
}

function toMilestone(row: ProjectMilestoneRow, payload: StoredMilestone): ProjectMilestone {
    return projectMilestoneSchema.parse({
        id: row.id,
        projectId: row.project_id,
        name: payload.name,
        description: payload.description,
        dueDate: row.due_date,
        reachedAt: row.reached_at,
        sortOrder: row.sort_order
    });
}

async function loadMilestone(
    ctx: Ctx,
    milestoneId: number
): Promise<{ milestone: ProjectMilestoneRow; project: ProjectRow }> {
    const milestone = await ctx.repo.plan.findMilestone(milestoneId, ctx.workspaceId);
    if (!milestone) throw new FeatureError('not_found', 'Jalon introuvable');
    const project = await loadProject(ctx, milestone.project_id);
    return { milestone, project };
}

/**
 * `from` mène-t-il à `target` en suivant les arêtes « bloquée par » ?
 *
 * Parcours en largeur sur le graphe complet du projet, chargé d'un coup : à
 * l'échelle d'un projet (quelques centaines d'arêtes au pire) c'est une lecture
 * et un parcours en mémoire, là où une requête récursive coûterait plus cher à
 * écrire qu'à exécuter.
 */
function reaches(deps: ProjectCardDepRow[], from: number, target: number): boolean {
    const blockers = new Map<number, number[]>();
    for (const dep of deps) {
        const list = blockers.get(dep.card_id);
        if (list) list.push(dep.blocked_by_card_id);
        else blockers.set(dep.card_id, [dep.blocked_by_card_id]);
    }
    const seen = new Set<number>();
    const queue = [from];
    while (queue.length > 0) {
        const current = queue.shift() as number;
        if (current === target) return true;
        if (seen.has(current)) continue;
        seen.add(current);
        for (const next of blockers.get(current) ?? []) queue.push(next);
    }
    return false;
}

export const projectPlanFeature = defineSdkFeature({
    ...projectPlan,
    handler: async (ctx: Ctx, input) => {
        const project = await loadProject(ctx, input.projectId);
        await assertProjectUnlocked(ctx, project);
        const cipher = cipherFor(ctx, project.security_tier);

        const [rows, deps] = await Promise.all([
            ctx.repo.plan.listMilestones(input.projectId, ctx.workspaceId),
            ctx.repo.plan.listDeps(input.projectId)
        ]);

        const milestones = await Promise.all(
            rows.map(async (row) => toMilestone(row, await decryptMilestone(cipher, row.content)))
        );
        return {
            milestones,
            deps: deps.map((d) => ({ cardId: d.card_id, blockedByCardId: d.blocked_by_card_id }))
        };
    }
});

export const projectMilestoneAddFeature = defineSdkFeature({
    ...projectMilestoneAdd,
    mutates: true,
    access: WRITE,
    handler: async (ctx: Ctx, input) => {
        const project = await loadProject(ctx, input.projectId);
        await assertProjectUnlocked(ctx, project);

        const cipher = cipherFor(ctx, project.security_tier);
        const payload = { name: input.milestone.name, description: input.milestone.description };
        const row = await ctx.repo.plan.createMilestone({
            projectId: input.projectId,
            workspaceId: ctx.workspaceId,
            dueDate: input.milestone.dueDate,
            content: await encryptMilestone(cipher, payload)
        });
        return { milestone: toMilestone(row, payload) };
    }
});

export const projectMilestoneUpdateFeature = defineSdkFeature({
    ...projectMilestoneUpdate,
    mutates: true,
    access: WRITE,
    handler: async (ctx: Ctx, input) => {
        const { project } = await loadMilestone(ctx, input.milestoneId);
        await assertProjectUnlocked(ctx, project);

        const cipher = cipherFor(ctx, project.security_tier);
        const payload = { name: input.milestone.name, description: input.milestone.description };
        const row = await ctx.repo.plan.updateMilestone(input.milestoneId, ctx.workspaceId, {
            dueDate: input.milestone.dueDate,
            content: await encryptMilestone(cipher, payload)
        });
        if (!row) throw new FeatureError('not_found', 'Jalon introuvable');
        return { milestone: toMilestone(row, payload) };
    }
});

export const projectMilestoneSetReachedFeature = defineSdkFeature({
    ...projectMilestoneSetReached,
    mutates: true,
    access: WRITE,
    handler: async (ctx: Ctx, input) => {
        const { project } = await loadMilestone(ctx, input.milestoneId);
        const row = await ctx.repo.plan.setMilestoneReached(
            input.milestoneId,
            ctx.workspaceId,
            input.reached ? Math.floor(Date.now() / 1000) : null
        );
        if (!row) throw new FeatureError('not_found', 'Jalon introuvable');
        const cipher = cipherFor(ctx, project.security_tier);
        const payload = await decryptMilestone(cipher, row.content);
        // Seule l'atteinte entre dans la frise : c'est un fait daté du projet.
        // Créer ou renommer un jalon n'en est pas un.
        if (input.reached) {
            await recordEvent(ctx, project, {
                kind: 'milestone.reached',
                refType: 'milestone',
                refId: row.id,
                label: payload.name
            });
        }
        return { milestone: toMilestone(row, payload) };
    }
});

export const projectMilestoneRemoveFeature = defineSdkFeature({
    ...projectMilestoneRemove,
    mutates: true,
    access: WRITE,
    handler: async (ctx: Ctx, input) => {
        const { project } = await loadMilestone(ctx, input.milestoneId);
        await assertProjectUnlocked(ctx, project);
        // Les cartes rattachées survivent : la contrainte est `ON DELETE SET
        // NULL`, elles se retrouvent simplement sans jalon.
        const ok = await ctx.repo.plan.deleteMilestone(input.milestoneId, ctx.workspaceId);
        if (!ok) throw new FeatureError('not_found', 'Jalon introuvable');
        return { milestoneId: input.milestoneId };
    }
});

export const projectCardSetMilestoneFeature = defineSdkFeature({
    ...projectCardSetMilestone,
    mutates: true,
    access: WRITE,
    handler: async (ctx: Ctx, input) => {
        const card = await ctx.repo.board.findCard(input.cardId, ctx.workspaceId);
        if (!card) throw new FeatureError('not_found', 'Carte introuvable');

        // Un jalon d'un autre projet n'a aucun sens ici : la contrainte SQL ne
        // le dit pas (elle ne connaît que l'existence), c'est donc à vérifier.
        if (input.milestoneId !== null) {
            const { milestone } = await loadMilestone(ctx, input.milestoneId);
            if (milestone.project_id !== card.project_id) {
                throw new FeatureError('validation', 'Ce jalon appartient à un autre projet.');
            }
        }

        const ok = await ctx.repo.plan.setCardMilestone(input.cardId, ctx.workspaceId, input.milestoneId);
        if (!ok) throw new FeatureError('not_found', 'Carte introuvable');
        return { cardId: input.cardId, milestoneId: input.milestoneId };
    }
});

export const projectDepAddFeature = defineSdkFeature({
    ...projectDepAdd,
    mutates: true,
    access: WRITE,
    handler: async (ctx: Ctx, input) => {
        if (input.cardId === input.blockedByCardId) {
            throw new FeatureError('validation', 'Une carte ne peut pas se bloquer elle-même.');
        }

        const [card, blocker] = await Promise.all([
            ctx.repo.board.findCard(input.cardId, ctx.workspaceId),
            ctx.repo.board.findCard(input.blockedByCardId, ctx.workspaceId)
        ]);
        if (!card || !blocker) throw new FeatureError('not_found', 'Carte introuvable');
        if (card.project_id !== blocker.project_id) {
            throw new FeatureError('validation', 'Une dépendance ne traverse pas deux projets.');
        }

        // Le cycle se referme si le bloqueur dépend déjà, de proche en proche,
        // de la carte qu'on s'apprête à bloquer.
        const deps = await ctx.repo.plan.listDeps(card.project_id);
        if (reaches(deps, input.blockedByCardId, input.cardId)) {
            throw new FeatureError(
                'validation',
                'Cette dépendance formerait un cycle : la carte bloquante dépend déjà de celle-ci.'
            );
        }

        await ctx.repo.plan.addDep(input.cardId, input.blockedByCardId, card.project_id);
        return { dep: { cardId: input.cardId, blockedByCardId: input.blockedByCardId } };
    }
});

export const projectDepRemoveFeature = defineSdkFeature({
    ...projectDepRemove,
    mutates: true,
    access: WRITE,
    handler: async (ctx: Ctx, input) => {
        const card = await ctx.repo.board.findCard(input.cardId, ctx.workspaceId);
        if (!card) throw new FeatureError('not_found', 'Carte introuvable');
        await ctx.repo.plan.removeDep(input.cardId, input.blockedByCardId);
        return { cardId: input.cardId, blockedByCardId: input.blockedByCardId };
    }
});

export const projectTimelineFeatures = [
    projectPlanFeature,
    projectMilestoneAddFeature,
    projectMilestoneUpdateFeature,
    projectMilestoneSetReachedFeature,
    projectMilestoneRemoveFeature,
    projectCardSetMilestoneFeature,
    projectDepAddFeature,
    projectDepRemoveFeature
];
