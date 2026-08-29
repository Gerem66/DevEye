import { z } from 'zod';

/**
 * La planification d'un projet : ses jalons, et les dépendances entre cartes. Les
 * dates, l'atteinte et le graphe des dépendances restent en colonnes claires, ce
 * qui permet de dessiner la frise et de détecter un cycle sans déchiffrer ; seuls
 * le nom et la description d'un jalon sont chiffrés.
 */

export const PROJECT_MILESTONE_NAME_MAX_LENGTH = 80;
export const PROJECT_MILESTONE_DESCRIPTION_MAX_LENGTH = 1000;

export const projectMilestoneSchema = z.object({
    id: z.number().int().positive(),
    projectId: z.number().int().positive(),
    name: z.string().max(PROJECT_MILESTONE_NAME_MAX_LENGTH),
    description: z.string().max(PROJECT_MILESTONE_DESCRIPTION_MAX_LENGTH),
    /** Échéance visée, en secondes unix. */
    dueDate: z.number().int(),
    reachedAt: z.number().int().nullable(),
    sortOrder: z.number().int().nonnegative()
});
export type ProjectMilestone = z.infer<typeof projectMilestoneSchema>;

export const projectMilestoneDraftSchema = z.object({
    name: z.string().min(1).max(PROJECT_MILESTONE_NAME_MAX_LENGTH),
    description: z.string().max(PROJECT_MILESTONE_DESCRIPTION_MAX_LENGTH),
    dueDate: z.number().int()
});
export type ProjectMilestoneDraft = z.infer<typeof projectMilestoneDraftSchema>;

/**
 * Une dépendance : `cardId` est bloquée par `blockedByCardId`. Le sens est fixé une
 * fois pour toutes, pour n'avoir jamais à se demander comment lire une arête.
 */
export const projectCardDepSchema = z.object({
    cardId: z.number().int().positive(),
    blockedByCardId: z.number().int().positive()
});
export type ProjectCardDep = z.infer<typeof projectCardDepSchema>;

/** Ligne SQL (serveur uniquement). */
export interface ProjectMilestoneRow {
    id: number;
    project_id: number;
    workspace_id: number;
    due_date: number;
    reached_at: number | null;
    sort_order: number;
    content: string;
    created: number;
}

/** Ligne SQL (serveur uniquement). */
export interface ProjectCardDepRow {
    card_id: number;
    blocked_by_card_id: number;
    project_id: number;
    created: number;
}
