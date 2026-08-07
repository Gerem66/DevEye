import { useMemo, useState } from 'react';
import type { MinimalUser, ProjectCard, ProjectCardDep, ProjectMilestone } from 'deveye-types';
import { Button } from '@/Components';
import { useLiveOutlines } from '@/live/useLiveOutline';
import { Avatar } from '../Board/Avatar';
import { DAY_MS, startOfDay, timelineTicks, ZOOM_LEVELS, type ZoomId } from './scale';
import styles from '../style.module.css';

/** Hauteur d'une ligne, en px. Fixe : c'est ce qui rend les flèches calculables
 *  sans mesurer le DOM. */
const ROW_H = 34;
const BAR_H = 20;

interface TimelineProps {
    cards: ProjectCard[];
    milestones: ProjectMilestone[];
    deps: ProjectCardDep[];
    members: MinimalUser[];
    canWrite: boolean;
    onCardOpen: (card: ProjectCard) => void;
    onMilestoneCreate: () => void;
    onMilestoneOpen: (milestone: ProjectMilestone) => void;
}

/**
 * La frise chronologique : les mêmes blocs que le kanban, posés sur le temps.
 *
 * N'y figurent que les cartes **datées** — c'est la demande, et c'est aussi la
 * seule chose qui ait un sens ici. Les autres sont listées dessous plutôt que
 * passées sous silence : une carte invisible est une carte oubliée.
 *
 * Une carte avec deux dates est une barre, une carte n'ayant qu'une échéance
 * est un point : afficher une durée qu'on n'a pas serait une invention.
 */
export function Timeline({
    cards,
    milestones,
    deps,
    members,
    canWrite,
    onCardOpen,
    onMilestoneCreate,
    onMilestoneOpen
}: TimelineProps) {
    const [zoom, setZoom] = useState<ZoomId>('quarter');
    const dayWidth = ZOOM_LEVELS.find((z) => z.id === zoom)?.dayWidth ?? 10;
    const outlineFor = useLiveOutlines('l2');

    const dated = useMemo(
        () =>
            cards
                .filter((c) => c.startDate !== null || c.dueDate !== null)
                .sort((a, b) => (a.startDate ?? a.dueDate ?? 0) - (b.startDate ?? b.dueDate ?? 0)),
        [cards]
    );
    const undated = useMemo(() => cards.filter((c) => c.startDate === null && c.dueDate === null), [cards]);

    /** La fenêtre couverte, marges comprises. */
    const range = useMemo(() => {
        const points: number[] = [];
        for (const c of dated) {
            if (c.startDate !== null) points.push(c.startDate * 1000);
            if (c.dueDate !== null) points.push(c.dueDate * 1000);
        }
        for (const m of milestones) points.push(m.dueDate * 1000);
        points.push(Date.now());
        const min = startOfDay(Math.min(...points));
        const max = Math.max(...points);
        // Au moins deux semaines de fenêtre, sinon une frise à une seule carte
        // s'écrase sur un trait.
        const span = Math.max(max - min, 14 * DAY_MS);
        return { min: min - 2 * DAY_MS, max: min + span + 2 * DAY_MS };
    }, [dated, milestones]);

    const width = Math.max(320, ((range.max - range.min) / DAY_MS) * dayWidth);
    const x = (t: number) => ((t - range.min) / DAY_MS) * dayWidth;
    const ticks = useMemo(() => timelineTicks(range.min, range.max, dayWidth), [range, dayWidth]);

    const rowOf = useMemo(() => new Map(dated.map((c, i) => [c.id, i])), [dated]);

    /** Le segment occupé par une carte : [début, fin] en px. */
    const spanOf = (card: ProjectCard) => {
        const start = card.startDate !== null ? card.startDate * 1000 : (card.dueDate as number) * 1000;
        const end = card.dueDate !== null ? card.dueDate * 1000 : (card.startDate as number) * 1000;
        const left = x(start);
        // Un jour minimum de largeur : une tâche d'un seul jour doit rester
        // cliquable même au zoom le plus large.
        const right = Math.max(x(end) + dayWidth, left + Math.max(dayWidth, 6));
        return { left, width: right - left, pointOnly: card.startDate === null || card.dueDate === null };
    };

    if (dated.length === 0 && milestones.length === 0) {
        return (
            <div className={styles.timelineEmpty}>
                <p className={styles.empty}>
                    Aucune carte datée ni jalon. Posez une date de début ou une échéance sur une carte pour la voir
                    apparaître ici.
                </p>
                {canWrite && (
                    <Button variant='secondary' icon='add' onClick={onMilestoneCreate}>
                        Ajouter un jalon
                    </Button>
                )}
            </div>
        );
    }

    const now = x(Date.now());

    return (
        <div className={styles.timeline}>
            <div className={styles.timelineBar}>
                <div className={styles.zoom}>
                    {ZOOM_LEVELS.map((z) => (
                        <button
                            key={z.id}
                            type='button'
                            className={z.id === zoom ? styles.zoomActive : styles.zoomBtn}
                            onClick={() => setZoom(z.id)}
                        >
                            {z.label}
                        </button>
                    ))}
                </div>
                {canWrite && (
                    <Button variant='secondary' icon='add' onClick={onMilestoneCreate}>
                        Jalon
                    </Button>
                )}
            </div>

            <div className={styles.timelineScroll}>
                <div className={styles.timelineInner} style={{ width }}>
                    {/* Graduations + jalons : une seule couche de fond, sous les barres. */}
                    <div className={styles.tlGrid} style={{ height: dated.length * ROW_H + 28 }}>
                        {ticks.map((tick) => (
                            <div
                                key={tick.t}
                                className={tick.major ? styles.gridLineMajor : styles.gridLine}
                                style={{ left: x(tick.t) }}
                            >
                                <span className={styles.gridLabel}>{tick.label}</span>
                            </div>
                        ))}

                        {now >= 0 && now <= width && <div className={styles.today} style={{ left: now }} />}

                        {milestones.map((m) => (
                            <button
                                key={m.id}
                                type='button'
                                className={m.reachedAt !== null ? styles.milestoneDone : styles.milestone}
                                style={{ left: x(m.dueDate * 1000) }}
                                title={`${m.name || 'Jalon'} — ${new Date(m.dueDate * 1000).toLocaleDateString('fr-FR')}`}
                                onClick={() => onMilestoneOpen(m)}
                            >
                                <span className='icon icon-star' />
                                <span className={styles.milestoneLabel}>{m.name || 'Jalon'}</span>
                            </button>
                        ))}
                    </div>

                    {/* Les liens de dépendance, au-dessus de la grille et sous les
                        barres : ils relient la fin du bloqueur au début du bloqué. */}
                    <svg
                        className={styles.depLayer}
                        width={width}
                        height={dated.length * ROW_H}
                        style={{ top: 28 }}
                        aria-hidden='true'
                    >
                        {deps.map((dep) => {
                            const from = cards.find((c) => c.id === dep.blockedByCardId);
                            const to = cards.find((c) => c.id === dep.cardId);
                            const fromRow = rowOf.get(dep.blockedByCardId);
                            const toRow = rowOf.get(dep.cardId);
                            if (!from || !to || fromRow === undefined || toRow === undefined) return null;
                            const a = spanOf(from);
                            const b = spanOf(to);
                            const x1 = a.left + a.width;
                            const y1 = fromRow * ROW_H + ROW_H / 2;
                            const x2 = b.left;
                            const y2 = toRow * ROW_H + ROW_H / 2;
                            const mid = x1 + Math.max(12, (x2 - x1) / 2);
                            return (
                                <path
                                    key={`${dep.cardId}-${dep.blockedByCardId}`}
                                    d={`M ${x1} ${y1} H ${mid} V ${y2} H ${x2}`}
                                    className={x2 < x1 ? styles.depLate : styles.dep}
                                    fill='none'
                                />
                            );
                        })}
                    </svg>

                    <div className={styles.rows} style={{ marginTop: 28 }}>
                        {dated.map((card) => {
                            const s = spanOf(card);
                            const assignee = members.find((m) => m.id === card.assigneeUserId);
                            const overdue = card.dueDate !== null && card.dueDate * 1000 < Date.now();
                            return (
                                <div key={card.id} className={styles.tlRow} style={{ height: ROW_H }}>
                                    <button
                                        type='button'
                                        className={`${styles.bar} ${s.pointOnly ? styles.barPoint : ''} ${
                                            overdue ? styles.barLate : ''
                                        }`}
                                        style={{ left: s.left, width: s.width, height: BAR_H }}
                                        onClick={() => onCardOpen(card)}
                                        title={card.title}
                                        {...outlineFor(`card:${card.id}`)}
                                    >
                                        <span className={styles.barLabel}>{card.title || 'Sans titre'}</span>
                                        {card.assigneeUserId !== null && <Avatar user={assignee} size={16} />}
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                </div>
            </div>

            {undated.length > 0 && (
                <details className={styles.undated}>
                    <summary>
                        {undated.length} carte{undated.length > 1 ? 's' : ''} sans date
                    </summary>
                    <ul className={styles.undatedList}>
                        {undated.map((card) => (
                            <li key={card.id}>
                                <button type='button' onClick={() => onCardOpen(card)}>
                                    {card.title || 'Sans titre'}
                                </button>
                            </li>
                        ))}
                    </ul>
                </details>
            )}
        </div>
    );
}

export default Timeline;
