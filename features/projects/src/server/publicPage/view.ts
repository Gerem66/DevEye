import type { ProjectStatus, UserColor } from '@deveye/types';
import type { PageThemeChoice } from '@deveye/types/sdk';

import type {
    ProjectCardRow,
    ProjectChecklistItem,
    ProjectColumnRow,
    ProjectMilestoneColor,
    ProjectMilestoneRow,
    ProjectPriority
} from '../../contracts/domain';

/**
 * Ce que le visiteur d'une page publique voit d'un projet, calculé sans HTML :
 * les options du propriétaire s'appliquent ici, et rien de ce qu'elles taisent
 * n'atteint le rendu.
 */

/** Assez pour reconnaître une tâche ; le CSS en coupe l'affichage à trois lignes. */
export const EXCERPT_MAX = 280;

export const STATUS_LABELS: Record<ProjectStatus, string> = {
    draft: 'Brouillon',
    active: 'En cours',
    paused: 'En pause',
    done: 'Terminé'
};

export interface PublicMember {
    name: string;
    color: UserColor;
}

export interface PublicAssignee {
    initials: string;
    name: string;
    color: UserColor;
}

export interface PublicSubtaskView {
    label: string;
    done: boolean;
    /** Avec l'option des personnes assignées seulement. */
    assignee: PublicAssignee | null;
}

export interface PublicCardView {
    /** Ce qui retrouve une carte dépliée quand le tableau se relit. */
    id: number;
    title: string;
    priority: ProjectPriority;
    excerpt: string;
    /** `null` sans sous-tâche. */
    checklist: { done: number; total: number } | null;
    /** Avec l'option des échéances seulement. */
    due: { at: number; overdue: boolean } | null;
    milestone: { name: string; color: ProjectMilestoneColor | null } | null;
    /** Avec l'option des personnes assignées seulement. */
    assignees: PublicAssignee[];
    /** Ce qu'un clic déplie, avec l'option des sous-tâches ; `null` sans elle, ou sans sous-tâche. */
    subtasks: PublicSubtaskView[] | null;
}

export interface PublicColumnView {
    name: string;
    done: boolean;
    cards: PublicCardView[];
}

export interface PublicBoardView {
    generatedAt: number;
    theme: PageThemeChoice;
    /** Tel que le propriétaire l'a choisi ; le rendu ne garde que ce qui se résout. */
    accent: string;
    title: string;
    /** Une URL de données d'image, ou vide. */
    icon: string;
    description: string;
    status: string;
    version: string;
    cardTotal: number;
    cardDone: number;
    columns: PublicColumnView[];
}

export interface PublicBoardInput {
    now: number;
    theme: PageThemeChoice;
    accent: string;
    project: { title: string; icon: string; description: string; version: string; status: ProjectStatus };
    columns: readonly { row: ProjectColumnRow; name: string }[];
    cards: readonly {
        row: ProjectCardRow;
        title: string;
        description: string;
        checklist: readonly ProjectChecklistItem[];
    }[];
    milestones: readonly { row: ProjectMilestoneRow; name: string; color: ProjectMilestoneColor | null }[];
    members: ReadonlyMap<number, PublicMember>;
    priorityOf(value: number): ProjectPriority;
    showDates: boolean;
    showAssignees: boolean;
    showSubtasks: boolean;
}

/** Une vignette n'est reprise que si c'est bien une image : la page la pose telle quelle dans `src`. */
const ICON_PATTERN = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/;

export function initialsOf(name: string): string {
    const words = name
        .trim()
        .split(/[\s._-]+/)
        .filter(Boolean);
    const letters = words.length > 1 ? [words[0], words[1]] : [words[0] ?? '?'];
    return letters
        .map((word) => Array.from(word)[0] ?? '')
        .join('')
        .toUpperCase();
}

function excerptOf(description: string): string {
    const flat = description.replace(/\s+/g, ' ').trim();
    return flat.length > EXCERPT_MAX ? `${flat.slice(0, EXCERPT_MAX - 1).trimEnd()}…` : flat;
}

export function buildBoardView(input: PublicBoardInput): PublicBoardView {
    const milestones = new Map(input.milestones.map((m) => [m.row.id, m]));
    const byColumn = new Map<number, PublicCardView[]>();
    const doneColumns = new Set(input.columns.filter((c) => c.row.counts_as_done === 1).map((c) => c.row.id));
    let cardTotal = 0;
    let cardDone = 0;

    // Un ancien membre n'a plus de nom ici : il n'apparaît pas.
    const assigneeOf = (id: number | null): PublicAssignee | null => {
        const member = id === null || !input.showAssignees ? undefined : input.members.get(id);
        return member ? { initials: initialsOf(member.name), name: member.name, color: member.color } : null;
    };

    for (const card of input.cards) {
        if (card.row.column_id === null || card.row.archived_at !== null) continue;
        const columnDone = doneColumns.has(card.row.column_id);
        cardTotal += 1;
        if (columnDone) cardDone += 1;

        const milestone = card.row.milestone_id === null ? undefined : milestones.get(card.row.milestone_id);
        const assigneeIds = input.showAssignees
            ? [card.row.assignee_user_id, ...card.checklist.map((item) => item.assigneeUserId)]
            : [];
        const assignees: PublicAssignee[] = [];
        for (const id of new Set(assigneeIds)) {
            const person = assigneeOf(id);
            if (person) assignees.push(person);
        }

        const due = card.row.due_date;
        const list = byColumn.get(card.row.column_id) ?? [];
        list.push({
            id: card.row.id,
            title: card.title.trim() || 'Sans titre',
            priority: input.priorityOf(card.row.priority),
            excerpt: excerptOf(card.description),
            checklist:
                card.checklist.length > 0
                    ? { done: card.checklist.filter((item) => item.done).length, total: card.checklist.length }
                    : null,
            due: input.showDates && due !== null ? { at: due, overdue: !columnDone && due < input.now } : null,
            milestone:
                input.showDates && milestone
                    ? { name: milestone.name.trim() || 'Sans nom', color: milestone.color }
                    : null,
            assignees,
            subtasks:
                input.showSubtasks && card.checklist.length > 0
                    ? card.checklist.map((item) => ({
                          label: item.label.trim() || 'Sans titre',
                          done: item.done,
                          assignee: assigneeOf(item.assigneeUserId)
                      }))
                    : null
        });
        byColumn.set(card.row.column_id, list);
    }

    return {
        generatedAt: input.now,
        theme: input.theme,
        accent: input.accent,
        title: input.project.title.trim() || 'Sans titre',
        icon: ICON_PATTERN.test(input.project.icon) ? input.project.icon : '',
        description: input.project.description.trim(),
        status: STATUS_LABELS[input.project.status],
        version: input.project.version.trim(),
        cardTotal,
        cardDone,
        columns: input.columns.map((column) => ({
            name: column.name.trim() || 'Sans nom',
            done: column.row.counts_as_done === 1,
            cards: byColumn.get(column.row.id) ?? []
        }))
    };
}
