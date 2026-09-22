import type { CSSProperties, ReactNode } from 'react';
import { CountBadge, useWorkspaceMembers } from 'deveye-sdk-client';

import { formatDate, relativeAgo } from '../api';
import { DUE_SOON_DAYS, type ProjectCard } from '../../contracts/domain';
import { HIDDEN_MEMBER_LABEL, MemberAvatar, MemberName } from '../Member';
import type { ProjectTabId } from '../tabs';
import type { TaskTileKey } from './catalogue';
import type { MemberLoad, TaskStats } from './taskStats';
import styles from '../style.module.css';

/** Lignes de charge montrées avant « et N autres ». */
const WORKLOAD_SHOWN = 6;

interface TaskTileBodyProps {
    tileKey: TaskTileKey;
    stats: TaskStats;
    now: number;
    onOpenCard: (card: ProjectCard) => void;
    onOpenTab: (tab: ProjectTabId) => void;
}

/**
 * Le corps d'une tuile de tâches. Tout vient de ce que la fiche du projet tient
 * déjà : aucune de ces tuiles ne demande rien au serveur, ni ne peut ouvrir une
 * invite de déverrouillage.
 */
export function TaskTileBody({ tileKey, stats, now, onOpenCard, onOpenTab }: TaskTileBodyProps) {
    const members = useWorkspaceMembers();

    const row = (card: ProjectCard, extra?: ReactNode) => (
        <li key={card.id}>
            <button
                type='button'
                className={styles.dashRow}
                aria-label={`Ouvrir la tâche ${card.title || 'sans titre'}`}
                onClick={() => onOpenCard(card)}
            >
                {card.priority !== 'none' && <span className={styles.priority} data-priority={card.priority} />}
                <span className={styles.dashRowName}>{card.title || 'Sans titre'}</span>
                {extra}
                {card.unread > 0 && (
                    <CountBadge count={card.unread} aria-label={`${card.unread} non lu${card.unread > 1 ? 's' : ''}`} />
                )}
            </button>
        </li>
    );

    const dueChip = (card: ProjectCard) =>
        card.dueDate === null ? null : (
            <span
                className={
                    card.dueDate < now
                        ? styles.dashChipDanger
                        : card.dueDate < now + DUE_SOON_DAYS * 86400
                          ? styles.dashChipWarn
                          : styles.dashChip
                }
            >
                {formatDate(card.dueDate)}
            </span>
        );

    const link = (tab: ProjectTabId, label: string) => (
        <button type='button' className={styles.dashLink} onClick={() => onOpenTab(tab)}>
            {label}
        </button>
    );

    switch (tileKey) {
        case 'tasks.progress': {
            const hours = Math.round(stats.estimateOpenMinutes / 60);
            // Une rampe sur l'accent, du plus pâle au plus franc dans l'ordre du
            // tableau ; la colonne qui vaut « terminé » en sort, en vert.
            const step = (i: number) => 30 + Math.round((i / Math.max(1, stats.byColumn.length - 1)) * 60);
            return (
                <>
                    <div className={styles.dashStack} aria-hidden='true'>
                        {stats.byColumn.map(
                            (column, i) =>
                                column.count > 0 && (
                                    <span
                                        key={column.id}
                                        className={styles.dashStackSlice}
                                        data-done={column.countsAsDone ? '' : undefined}
                                        title={`${column.name || 'Sans nom'} : ${column.count}`}
                                        style={{ flexGrow: column.count, '--step': step(i) } as CSSProperties}
                                    />
                                )
                        )}
                    </div>
                    <ul className={styles.dashLegend} aria-label='Tâches par colonne'>
                        {stats.byColumn.map((column, i) => {
                            const over = column.wipLimit !== null && column.count > column.wipLimit;
                            return (
                                <li key={column.id} className={styles.dashLegendItem}>
                                    <span
                                        className={styles.dashLegendDot}
                                        data-done={column.countsAsDone ? '' : undefined}
                                        style={{ '--step': step(i) } as CSSProperties}
                                    />
                                    <span className={styles.dashRowName}>{column.name || 'Sans nom'}</span>
                                    <span
                                        className={over ? styles.dashChipWarn : styles.dashLegendCount}
                                        title={
                                            over ? `Limite de ${column.wipLimit}, ${column.count} en cours` : undefined
                                        }
                                    >
                                        {column.count}
                                    </span>
                                </li>
                            );
                        })}
                    </ul>
                    {stats.blocked > 0 && (
                        <p className={styles.dashTileNote}>
                            {stats.blocked === 1
                                ? '1 tâche attend une autre tâche.'
                                : `${stats.blocked} tâches attendent une autre tâche.`}
                        </p>
                    )}
                    {hours > 0 && <p className={styles.dashTileNote}>Environ {hours} h estimées sur ce qui reste.</p>}
                </>
            );
        }

        case 'tasks.due':
            return stats.dueNext.length > 0 ? (
                <ul className={styles.dashRows} aria-label='Prochaines échéances'>
                    {stats.dueNext.map((card) =>
                        row(
                            card,
                            <>
                                {dueChip(card)}
                                {card.assigneeUserId !== null && (
                                    <MemberAvatar userId={card.assigneeUserId} size={18} />
                                )}
                            </>
                        )
                    )}
                </ul>
            ) : (
                <p className={styles.dashTileNote}>
                    Aucune tâche datée. {link('timeline', 'Les dates se posent sur la Frise.')}
                </p>
            );

        case 'tasks.mine':
            return stats.mine.length > 0 ? (
                <>
                    <ul className={styles.dashRows} aria-label='Mes tâches dans ce projet'>
                        {stats.mine.map((card) => {
                            const done = card.checklist.filter((i) => i.done).length;
                            return row(
                                card,
                                <>
                                    {stats.blockedIds.has(card.id) && (
                                        <span
                                            className={`icon icon-lock ${styles.chipIcon}`}
                                            role='img'
                                            aria-label='Attend une autre tâche'
                                            title='Attend une autre tâche'
                                        />
                                    )}
                                    {card.checklist.length > 0 && (
                                        <span className={styles.dashChip}>
                                            {done}/{card.checklist.length}
                                        </span>
                                    )}
                                    {dueChip(card)}
                                </>
                            );
                        })}
                    </ul>
                    {stats.mineMore > 0 && (
                        <p className={styles.dashTileNote}>
                            et {stats.mineMore} autre{stats.mineMore > 1 ? 's' : ''}
                        </p>
                    )}
                </>
            ) : (
                <p className={styles.dashTileNote}>Rien ne vous est attribué dans ce projet.</p>
            );

        case 'tasks.workload': {
            // Les membres d'un autre espace ne sont ni nommés ni comptés un par un :
            // autant de lignes masquées diraient l'effectif de l'espace d'en face.
            const known = (l: MemberLoad) => l.userId === null || members.some((m) => m.id === l.userId);
            const hidden = stats.workload.filter((l) => !known(l));
            const lines: (MemberLoad & { label?: string })[] = stats.workload.filter(known);
            if (hidden.length > 0) {
                lines.push({
                    userId: -1,
                    label: hidden.length === 1 ? HIDDEN_MEMBER_LABEL : 'Membres hors de cet espace',
                    open: hidden.reduce((n, l) => n + l.open, 0),
                    overdue: hidden.reduce((n, l) => n + l.overdue, 0)
                });
            }
            if (lines.length === 0) return <p className={styles.dashTileNote}>Aucune tâche ouverte.</p>;
            const most = Math.max(...lines.map((l) => l.open));
            const shown = lines.slice(0, WORKLOAD_SHOWN);
            return (
                <>
                    <ul className={styles.dashRows} aria-label='Tâches ouvertes par personne'>
                        {shown.map((load) => (
                            <li key={load.userId ?? 'none'} className={styles.dashLoad}>
                                {load.userId !== null && load.label === undefined ? (
                                    <>
                                        <MemberAvatar userId={load.userId} size={20} />
                                        <span className={styles.dashLoadName}>
                                            <MemberName userId={load.userId} />
                                        </span>
                                    </>
                                ) : (
                                    <span className={styles.dashLoadName} data-muted=''>
                                        {load.label ?? 'Sans attributaire'}
                                    </span>
                                )}
                                <span className={styles.dashMeter} aria-hidden='true'>
                                    <span
                                        className={styles.dashMeterFill}
                                        data-muted={load.userId === null ? '' : undefined}
                                        style={{ width: `${(load.open / most) * 100}%` }}
                                    />
                                </span>
                                <span className={styles.dashLegendCount}>
                                    {load.open} ouverte{load.open > 1 ? 's' : ''}
                                </span>
                                {load.overdue > 0 && (
                                    <span className={styles.dashChipDanger}>{load.overdue} en retard</span>
                                )}
                            </li>
                        ))}
                    </ul>
                    {lines.length > shown.length && (
                        <p className={styles.dashTileNote}>et {lines.length - shown.length} autres</p>
                    )}
                </>
            );
        }

        case 'tasks.milestone': {
            const progress = stats.milestoneProgress;
            if (stats.nextMilestone === null) {
                return (
                    <p className={styles.dashTileNote}>
                        Aucun jalon à venir. {link('timeline', 'Les jalons se posent sur la Frise.')}
                    </p>
                );
            }
            if (progress === null || progress.total === 0) return null;
            return (
                <>
                    <span className={styles.dashMeter} aria-hidden='true'>
                        <span
                            className={styles.dashMeterFill}
                            style={{ width: `${(progress.done / progress.total) * 100}%` }}
                        />
                    </span>
                    <p className={styles.dashTileNote}>
                        {progress.done} / {progress.total} tâche{progress.total > 1 ? 's' : ''} du jalon terminée
                        {progress.done > 1 ? 's' : ''}
                    </p>
                </>
            );
        }

        case 'tasks.activity':
            return (
                <>
                    <ul className={styles.dashRows} aria-label='Dernières tâches retouchées'>
                        {stats.recent.map((card) =>
                            row(card, <span className={styles.dashChip}>{relativeAgo(card.updated, now)}</span>)
                        )}
                    </ul>
                    <p className={styles.dashTileNote}>
                        Archivages, versions et déploiements sont dans l’Historique, au dernier onglet des réglages.
                    </p>
                </>
            );
    }
}

export default TaskTileBody;
