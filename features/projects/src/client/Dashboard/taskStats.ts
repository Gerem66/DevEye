import {
    DUE_SOON_DAYS,
    type ProjectCard,
    type ProjectCardDep,
    type ProjectColumn,
    type ProjectMilestone
} from '../../contracts/domain';

/**
 * Ce que la vue d'ensemble sait des tâches, calculé de ce que l'écran tient
 * déjà : aucun aller-retour, et la même règle que le portefeuille.
 *
 * « Dépassée » est `dueDate < now`, l'instant et non le début du jour : c'est
 * mot pour mot ce que `statsFor` compte en SQL, et deux définitions voisines
 * pour le même mot se liraient comme un bug.
 */

export interface TaskStats {
    /** Cartes vivantes : `projects.board` ne rend pas les archivées. */
    total: number;
    done: number;
    open: number;
    /** Échéance passée, sur une carte qui n'est pas dans une colonne de fin. */
    overdue: number;
    /** Échéance dans les {@link DUE_SOON_DAYS} jours. */
    dueSoon: number;
    /** Sans échéance : ni en retard, ni bientôt dues, mais pas oubliées. */
    undated: number;
    /** Bloquées par une carte qui n'est pas terminée. */
    blocked: number;
    /** Le prochain jalon non atteint, et ceux qui ont laissé passer leur date. */
    nextMilestone: ProjectMilestone | null;
    lateMilestones: number;
}

export function taskStats(
    columns: readonly ProjectColumn[],
    cards: readonly ProjectCard[],
    milestones: readonly ProjectMilestone[],
    deps: readonly ProjectCardDep[],
    now: number
): TaskStats {
    const doneColumns = new Set(columns.filter((c) => c.countsAsDone).map((c) => c.id));
    const isDone = (card: ProjectCard): boolean => card.columnId !== null && doneColumns.has(card.columnId);
    const soonUntil = now + DUE_SOON_DAYS * 86400;

    const open = cards.filter((c) => !isDone(c));
    const doneIds = new Set(cards.filter(isDone).map((c) => c.id));

    const reached = milestones.filter((m) => m.reachedAt === null);
    const upcoming = reached.filter((m) => m.dueDate >= now).sort((a, b) => a.dueDate - b.dueDate || a.id - b.id);

    return {
        total: cards.length,
        done: cards.length - open.length,
        open: open.length,
        overdue: open.filter((c) => c.dueDate !== null && c.dueDate < now).length,
        dueSoon: open.filter((c) => c.dueDate !== null && c.dueDate >= now && c.dueDate < soonUntil).length,
        undated: open.filter((c) => c.dueDate === null).length,
        // Une seule dépendance non terminée suffit à bloquer : on compte les
        // cartes, pas les liens.
        blocked: new Set(
            deps.filter((d) => !doneIds.has(d.blockedByCardId) && !doneIds.has(d.cardId)).map((d) => d.cardId)
        ).size,
        nextMilestone: upcoming[0] ?? null,
        lateMilestones: reached.filter((m) => m.dueDate < now).length
    };
}
