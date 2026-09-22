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
    /** Terminées sur vivantes, en pourcentage entier ; 0 sans carte. */
    percentDone: number;
    /** Les colonnes dans l'ordre du tableau, chacune avec ses cartes vivantes. */
    byColumn: ColumnLoad[];
    /** La somme des estimations des cartes ouvertes ; 0 quand aucune n'en porte. */
    estimateOpenMinutes: number;
    blockedIds: ReadonlySet<number>;
    /** Les cartes ouvertes par attributaire, le plus chargé d'abord ; `null` = personne. */
    workload: MemberLoad[];
    /** Les cartes ouvertes de l'appelant, retards d'abord, et combien la liste en tait. */
    mine: ProjectCard[];
    mineMore: number;
    /** Les prochaines cartes ouvertes datées, la plus pressante d'abord. */
    dueNext: ProjectCard[];
    /** Les dernières cartes retouchées. */
    recent: ProjectCard[];
    /** L'avancement des cartes rattachées au prochain jalon ; `null` sans jalon. */
    milestoneProgress: { done: number; total: number } | null;
}

export interface ColumnLoad {
    id: number;
    name: string;
    count: number;
    countsAsDone: boolean;
    wipLimit: number | null;
}

export interface MemberLoad {
    userId: number | null;
    open: number;
    overdue: number;
}

const MINE_SHOWN = 5;
const DUE_SHOWN = 3;
const RECENT_SHOWN = 4;
const PRIORITY_RANK = { high: 0, normal: 1, low: 2, none: 3 } as const;

export function taskStats(
    columns: readonly ProjectColumn[],
    cards: readonly ProjectCard[],
    milestones: readonly ProjectMilestone[],
    deps: readonly ProjectCardDep[],
    meUserId: number,
    now: number
): TaskStats {
    const doneColumns = new Set(columns.filter((c) => c.countsAsDone).map((c) => c.id));
    const isDone = (card: ProjectCard): boolean => card.columnId !== null && doneColumns.has(card.columnId);
    const soonUntil = now + DUE_SOON_DAYS * 86400;

    const open = cards.filter((c) => !isDone(c));
    const doneIds = new Set(cards.filter(isDone).map((c) => c.id));

    const reached = milestones.filter((m) => m.reachedAt === null);
    const upcoming = reached.filter((m) => m.dueDate >= now).sort((a, b) => a.dueDate - b.dueDate || a.id - b.id);

    const isLate = (c: ProjectCard): boolean => c.dueDate !== null && c.dueDate < now;
    // Une seule dépendance non terminée suffit à bloquer : on compte les
    // cartes, pas les liens.
    const blockedIds = new Set(
        deps.filter((d) => !doneIds.has(d.blockedByCardId) && !doneIds.has(d.cardId)).map((d) => d.cardId)
    );

    const loads = new Map<number | null, MemberLoad>();
    for (const card of open) {
        const load = loads.get(card.assigneeUserId) ?? { userId: card.assigneeUserId, open: 0, overdue: 0 };
        load.open += 1;
        if (isLate(card)) load.overdue += 1;
        loads.set(card.assigneeUserId, load);
    }

    const byUrgency = (a: ProjectCard, b: ProjectCard): number =>
        Number(isLate(b)) - Number(isLate(a)) ||
        (a.dueDate ?? Number.POSITIVE_INFINITY) - (b.dueDate ?? Number.POSITIVE_INFINITY) ||
        PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
        a.sortOrder - b.sortOrder;
    const mine = open.filter((c) => c.assigneeUserId === meUserId).sort(byUrgency);

    const next = upcoming[0] ?? null;
    const ofNext = next === null ? [] : cards.filter((c) => c.milestoneId === next.id);

    return {
        total: cards.length,
        done: cards.length - open.length,
        open: open.length,
        overdue: open.filter(isLate).length,
        dueSoon: open.filter((c) => c.dueDate !== null && c.dueDate >= now && c.dueDate < soonUntil).length,
        undated: open.filter((c) => c.dueDate === null).length,
        blocked: blockedIds.size,
        nextMilestone: next,
        lateMilestones: reached.filter((m) => m.dueDate < now).length,
        percentDone: cards.length === 0 ? 0 : Math.round(((cards.length - open.length) / cards.length) * 100),
        byColumn: columns.map((column) => ({
            id: column.id,
            name: column.name,
            count: cards.filter((c) => c.columnId === column.id).length,
            countsAsDone: column.countsAsDone,
            wipLimit: column.wipLimit
        })),
        estimateOpenMinutes: open.reduce((sum, c) => sum + (c.estimateMinutes ?? 0), 0),
        blockedIds,
        // Sans attributaire en dernier, quel que soit son compte : c'est une
        // alerte à part, pas un membre de plus dans le classement.
        workload: [...loads.values()].sort(
            (a, b) => Number(a.userId === null) - Number(b.userId === null) || b.open - a.open
        ),
        mine: mine.slice(0, MINE_SHOWN),
        mineMore: Math.max(0, mine.length - MINE_SHOWN),
        dueNext: open
            .filter((c) => c.dueDate !== null)
            .sort(byUrgency)
            .slice(0, DUE_SHOWN),
        recent: [...cards].sort((a, b) => b.updated - a.updated || b.id - a.id).slice(0, RECENT_SHOWN),
        milestoneProgress: next === null ? null : { done: ofNext.filter(isDone).length, total: ofNext.length }
    };
}
