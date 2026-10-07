import type { ProjectCard, ProjectEvent } from '../../contracts/domain';

export type HistoryEntry =
    { type: 'event'; event: ProjectEvent; card: ProjectCard | undefined } | { type: 'card'; card: ProjectCard };

/**
 * Les événements et les tâches archivées en une seule frise, la plus récente en
 * tête. Une tâche archivée d'un geste a son événement, qui l'ouvre ; les autres,
 * parties avec leur colonne, y entrent à leur date d'archivage, sous l'entrée de
 * la colonne vidée. Tant qu'une page d'événements reste à charger, seules celles
 * de la période chargée paraissent : la suite amène les autres à leur place.
 */
export function historyEntries(
    events: readonly ProjectEvent[],
    hasMore: boolean,
    cards: readonly ProjectCard[]
): HistoryEntry[] {
    const byId = new Map(cards.map((c) => [c.id, c]));
    const told = new Set<number>();
    for (const e of events) if (e.kind === 'card.archived' && e.refId !== null) told.add(e.refId);
    const oldest = events.length > 0 ? events[events.length - 1].created : null;
    const loose = cards
        .filter((c) => !told.has(c.id))
        .filter((c) => !hasMore || (oldest !== null && c.archivedAt !== null && c.archivedAt >= oldest))
        .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0));

    const out: HistoryEntry[] = [];
    let i = 0;
    for (const event of events) {
        while (i < loose.length && (loose[i].archivedAt ?? 0) > event.created) {
            out.push({ type: 'card', card: loose[i++] });
        }
        const card = event.kind === 'card.archived' && event.refId !== null ? byId.get(event.refId) : undefined;
        out.push({ type: 'event', event, card });
    }
    while (i < loose.length) out.push({ type: 'card', card: loose[i++] });
    return out;
}
