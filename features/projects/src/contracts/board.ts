import { z } from 'zod';

/**
 * Le tableau d'un projet : ses colonnes, et les blocs qui y circulent. Reste en
 * clair tout ce qui sert à ordonner, filtrer et compter sans clé (colonne, rang,
 * attributaire, priorité, dates, archivage, compteur de messages) ; le titre, la
 * description et les sous-tâches sont chiffrés. L'attributaire en clair est ce qui
 * rend « toutes mes tâches, tous projets confondus » possible en une requête.
 */

export const PROJECT_COLUMN_NAME_MAX_LENGTH = 48;
export const PROJECT_MAX_COLUMNS = 12;
export const PROJECT_CARD_TITLE_MAX_LENGTH = 160;
export const PROJECT_CARD_DESCRIPTION_MAX_LENGTH = 4000;
export const PROJECT_CHECKLIST_LABEL_MAX_LENGTH = 160;
export const PROJECT_MAX_CHECKLIST_ITEMS = 50;

/**
 * Priorité d'une carte. L'indice dans ce tableau est la valeur stockée en base
 * (`project_cards.priority`, un TINYINT), pour que le tri reste du SQL : ne jamais
 * réordonner ces valeurs, ce serait réétiqueter toutes les cartes existantes.
 */
export const projectPrioritySchema = z.enum(['none', 'low', 'normal', 'high']);
export type ProjectPriority = z.infer<typeof projectPrioritySchema>;
export const PROJECT_PRIORITIES = projectPrioritySchema.options;

/** `id` est engendré par le client : c'est sa clé de rendu. */
export const projectChecklistItemSchema = z.object({
    id: z.string().min(1).max(64),
    label: z.string().max(PROJECT_CHECKLIST_LABEL_MAX_LENGTH),
    done: z.boolean()
});
export type ProjectChecklistItem = z.infer<typeof projectChecklistItemSchema>;

export const projectColumnSchema = z.object({
    id: z.number().int().positive(),
    projectId: z.number().int().positive(),
    name: z.string().max(PROJECT_COLUMN_NAME_MAX_LENGTH),
    sortOrder: z.number().int().nonnegative(),
    /** En clair : l'avancement d'un projet reste calculable en SQL. */
    countsAsDone: z.boolean(),
    /** Limite de travail en cours ; `null` = aucune. Indicative, jamais bloquante. */
    wipLimit: z.number().int().positive().nullable()
});
export type ProjectColumn = z.infer<typeof projectColumnSchema>;

export const projectCardSchema = z.object({
    id: z.number().int().positive(),
    projectId: z.number().int().positive(),
    /**
     * `null` quand la colonne a été retirée sous une carte archivée : celle-ci ne
     * circule plus, l'archive ne montre aucune colonne, et la restauration lui en
     * redonne une.
     */
    columnId: z.number().int().positive().nullable(),
    title: z.string().max(PROJECT_CARD_TITLE_MAX_LENGTH),
    description: z.string().max(PROJECT_CARD_DESCRIPTION_MAX_LENGTH),
    checklist: z.array(projectChecklistItemSchema).max(PROJECT_MAX_CHECKLIST_ITEMS),
    sortOrder: z.number().int().nonnegative(),
    priority: projectPrioritySchema,
    /** `null` quand le compte a été supprimé depuis. */
    authorUserId: z.number().int().positive().nullable(),
    assigneeUserId: z.number().int().positive().nullable(),
    startDate: z.number().int().nullable(),
    dueDate: z.number().int().nullable(),
    estimateMinutes: z.number().int().nonnegative().nullable(),
    milestoneId: z.number().int().positive().nullable(),
    archived: z.boolean(),
    archivedAt: z.number().int().nullable(),
    /** Le total du fil, et ce que l'appelant n'a pas encore lu. */
    messageCount: z.number().int().nonnegative(),
    unread: z.number().int().nonnegative(),
    created: z.number().int(),
    updated: z.number().int()
});
export type ProjectCard = z.infer<typeof projectCardSchema>;

export const projectCardDraftSchema = z.object({
    title: z.string().min(1).max(PROJECT_CARD_TITLE_MAX_LENGTH),
    description: z.string().max(PROJECT_CARD_DESCRIPTION_MAX_LENGTH),
    checklist: z.array(projectChecklistItemSchema).max(PROJECT_MAX_CHECKLIST_ITEMS),
    priority: projectPrioritySchema,
    assigneeUserId: z.number().int().positive().nullable(),
    startDate: z.number().int().nullable(),
    dueDate: z.number().int().nullable(),
    estimateMinutes: z.number().int().nonnegative().nullable()
});
export type ProjectCardDraft = z.infer<typeof projectCardDraftSchema>;

/** Ligne SQL (serveur uniquement). */
export interface ProjectColumnRow {
    id: number;
    project_id: number;
    workspace_id: number;
    sort_order: number;
    counts_as_done: number;
    wip_limit: number | null;
    content: string;
    created: number;
}

/** Ligne SQL (serveur uniquement). */
export interface ProjectCardRow {
    id: number;
    project_id: number;
    workspace_id: number;
    column_id: number | null;
    sort_order: number;
    author_user_id: number | null;
    assignee_user_id: number | null;
    priority: number;
    start_date: number | null;
    due_date: number | null;
    estimate_minutes: number | null;
    milestone_id: number | null;
    archived_at: number | null;
    message_count: number;
    last_message_at: number | null;
    content: string;
    created: number;
    updated: number;
}
