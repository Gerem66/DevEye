import { useCallback, useMemo, useRef, useState } from 'react';
import {
    DndContext,
    DragOverlay,
    KeyboardSensor,
    MeasuringStrategy,
    PointerSensor,
    closestCenter,
    pointerWithin,
    useDroppable,
    useSensor,
    useSensors,
    type CollisionDetection,
    type DragEndEvent,
    type DragOverEvent,
    type DragStartEvent
} from '@dnd-kit/core';
import {
    SortableContext,
    arrayMove,
    sortableKeyboardCoordinates,
    useSortable,
    verticalListSortingStrategy
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { MinimalUser, ProjectCard, ProjectColumn } from 'deveye-types';
import { Button } from '@/Components';
import { useLiveOutlines, type LiveOutlineProps } from '@/live/useLiveOutline';
import { formatDate, PRIORITY_LABELS } from '../api';
import { Avatar } from './Avatar';
import styles from '../style.module.css';

interface BoardProps {
    columns: ProjectColumn[];
    cards: ProjectCard[];
    members: MinimalUser[];
    canWrite: boolean;
    /** Applique un nouvel ordre localement (optimiste) puis le persiste. */
    onCardsMoved: (columnId: number, cardIds: number[], next: ProjectCard[]) => void;
    onCardOpen: (card: ProjectCard) => void;
    onCardCreate: (columnId: number) => void;
    onColumnEdit: (column: ProjectColumn) => void;
    onColumnMove: (columnId: number, direction: -1 | 1) => void;
    onColumnCreate: () => void;
}

/**
 * Le kanban.
 *
 * Le glisser-déposer passe par **dnd-kit**, déjà utilisé par l'éditeur
 * d'accueil (`Pages/Home/organize/EditableHome.tsx`) pour exactement ce
 * problème : des conteneurs multiples entre lesquels un élément circule. On en
 * reprend la mécanique — la carte rejoint la colonne survolée dès qu'elle y
 * entre (`onDragOver`), et non au lâcher, pour que les voisines s'écartent et
 * que la colonne d'origine se referme.
 *
 * À noter : `nativeDrag.ts` neutralise tous les glissers HTML5 natifs de
 * l'application. dnd-kit travaille en événements pointeur, il n'est donc pas
 * concerné — mais un `draggable` maison le serait.
 *
 * Les colonnes se réordonnent par des flèches plutôt qu'au glisser : imbriquer
 * un second niveau de tri dans le même DndContext coûte cher en cas limites
 * pour un geste qu'on fait trois fois dans la vie d'un projet.
 */
export function Board({
    columns,
    cards,
    members,
    canWrite,
    onCardsMoved,
    onCardOpen,
    onCardCreate,
    onColumnEdit,
    onColumnMove,
    onColumnCreate
}: BoardProps) {
    const [activeId, setActiveId] = useState<number | null>(null);
    /** D'où la carte est partie, pour la remettre en place sur Échap. */
    const origin = useRef<{ columnId: number; index: number } | null>(null);
    const outlineFor = useLiveOutlines('l2');

    const sensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
        useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
    );

    const byColumn = useMemo(() => {
        const map = new Map<number, ProjectCard[]>();
        for (const column of columns) map.set(column.id, []);
        for (const card of cards) {
            const list = map.get(card.columnId);
            if (list) list.push(card);
        }
        for (const list of map.values()) list.sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
        return map;
    }, [columns, cards]);

    const activeCard = activeId === null ? null : (cards.find((c) => c.id === activeId) ?? null);

    /**
     * La colonne visée : soit une carte survolée, soit la colonne elle-même —
     * c'est ce second cas qui permet de déposer dans une colonne vide.
     */
    const columnOf = useCallback(
        (overId: string): number | null => {
            if (overId.startsWith('col:')) return Number(overId.slice(4));
            const card = cards.find((c) => c.id === Number(overId));
            return card ? card.columnId : null;
        },
        [cards]
    );

    const collisionDetection = useCallback<CollisionDetection>((args) => {
        // `pointerWithin` d'abord : il seul distingue une colonne vide survolée.
        const pointer = pointerWithin(args);
        return pointer.length > 0 ? pointer : closestCenter(args);
    }, []);

    const locate = (cardId: number) => {
        const card = cards.find((c) => c.id === cardId);
        if (!card) return null;
        const list = byColumn.get(card.columnId) ?? [];
        return { columnId: card.columnId, index: list.findIndex((c) => c.id === cardId) };
    };

    const onDragStart = (e: DragStartEvent) => {
        const id = Number(e.active.id);
        origin.current = locate(id);
        setActiveId(id);
    };

    /** Reclasse localement pendant le survol, sans rien envoyer au serveur. */
    const onDragOver = (e: DragOverEvent) => {
        const { active, over } = e;
        if (!over || activeId === null) return;
        const activeCardId = Number(active.id);
        const targetColumn = columnOf(String(over.id));
        if (targetColumn === null) return;
        const current = cards.find((c) => c.id === activeCardId);
        if (!current || current.columnId === targetColumn) return;

        const target = byColumn.get(targetColumn) ?? [];
        const overIndex = target.findIndex((c) => c.id === Number(over.id));
        const at = overIndex < 0 ? target.length : overIndex;
        const nextIds = [...target.map((c) => c.id)];
        nextIds.splice(at, 0, activeCardId);
        onCardsMoved(targetColumn, nextIds, applyOrder(cards, targetColumn, nextIds));
    };

    const onDragEnd = (e: DragEndEvent) => {
        const { active, over } = e;
        setActiveId(null);
        origin.current = null;
        if (!over) return;

        const cardId = Number(active.id);
        const card = cards.find((c) => c.id === cardId);
        if (!card) return;
        const targetColumn = columnOf(String(over.id));
        if (targetColumn === null) return;

        const list = byColumn.get(targetColumn) ?? [];
        const from = list.findIndex((c) => c.id === cardId);
        const to = list.findIndex((c) => c.id === Number(over.id));
        const ids = list.map((c) => c.id);
        const nextIds = from >= 0 && to >= 0 && from !== to ? arrayMove(ids, from, to) : ids;
        onCardsMoved(targetColumn, nextIds, applyOrder(cards, targetColumn, nextIds));
    };

    /** Échap en cours de glisser : la carte retourne d'où elle vient. */
    const onDragCancel = () => {
        const back = origin.current;
        const id = activeId;
        setActiveId(null);
        origin.current = null;
        if (!back || id === null) return;
        const list = (byColumn.get(back.columnId) ?? []).map((c) => c.id).filter((c) => c !== id);
        list.splice(back.index, 0, id);
        onCardsMoved(back.columnId, list, applyOrder(cards, back.columnId, list));
    };

    return (
        <DndContext
            sensors={sensors}
            collisionDetection={collisionDetection}
            measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
            onDragStart={onDragStart}
            onDragOver={onDragOver}
            onDragEnd={onDragEnd}
            onDragCancel={onDragCancel}
        >
            <div className={styles.board}>
                {columns.map((column, index) => (
                    <Column
                        key={column.id}
                        column={column}
                        cards={byColumn.get(column.id) ?? []}
                        members={members}
                        canWrite={canWrite}
                        first={index === 0}
                        last={index === columns.length - 1}
                        outlineFor={outlineFor}
                        onCardOpen={onCardOpen}
                        onCardCreate={onCardCreate}
                        onEdit={onColumnEdit}
                        onMove={onColumnMove}
                    />
                ))}
                {canWrite && (
                    <button type='button' className={styles.addColumn} onClick={onColumnCreate}>
                        <span className='icon icon-add' /> Colonne
                    </button>
                )}
            </div>

            {/* La copie flottante reprend exactement la carte, sans son contour
                de présence — deux cadres superposés seraient illisibles. */}
            <DragOverlay>{activeCard && <CardBody card={activeCard} members={members} dragging />}</DragOverlay>
        </DndContext>
    );
}

/** Réordonne `cards` pour refléter le nouvel ordre d'une colonne. */
function applyOrder(cards: ProjectCard[], columnId: number, ids: number[]): ProjectCard[] {
    const rank = new Map(ids.map((id, i) => [id, i]));
    return cards.map((card) =>
        rank.has(card.id) ? { ...card, columnId, sortOrder: rank.get(card.id) as number } : card
    );
}

interface ColumnProps {
    column: ProjectColumn;
    cards: ProjectCard[];
    members: MinimalUser[];
    canWrite: boolean;
    first: boolean;
    last: boolean;
    outlineFor: (value: string | null) => LiveOutlineProps;
    onCardOpen: (card: ProjectCard) => void;
    onCardCreate: (columnId: number) => void;
    onEdit: (column: ProjectColumn) => void;
    onMove: (columnId: number, direction: -1 | 1) => void;
}

function Column({
    column,
    cards,
    members,
    canWrite,
    first,
    last,
    outlineFor,
    onCardOpen,
    onCardCreate,
    onEdit,
    onMove
}: ColumnProps) {
    // Droppable propre à la colonne : c'est ce qui rend une colonne **vide**
    // capable de recevoir une carte.
    const { setNodeRef, isOver } = useDroppable({ id: `col:${column.id}` });
    const ids = cards.map((c) => c.id);
    // La limite est indicative : on la signale, on ne refuse jamais le dépôt.
    const overLimit = column.wipLimit !== null && cards.length > column.wipLimit;

    return (
        <section className={styles.column}>
            <header className={styles.columnHead}>
                <span className={styles.columnName}>{column.name || 'Sans nom'}</span>
                <span className={overLimit ? styles.columnCountOver : styles.columnCount}>
                    {cards.length}
                    {column.wipLimit !== null && `/${column.wipLimit}`}
                </span>
                {column.countsAsDone && (
                    <span className={styles.doneFlag} title='Cette colonne vaut « terminé »'>
                        <span className='icon icon-check-circle' />
                    </span>
                )}
                {canWrite && (
                    <span className={styles.columnActions}>
                        <button
                            type='button'
                            onClick={() => onMove(column.id, -1)}
                            disabled={first}
                            title='Déplacer à gauche'
                            aria-label='Déplacer la colonne à gauche'
                        >
                            <span className='icon icon-menu-left' />
                        </button>
                        <button
                            type='button'
                            onClick={() => onMove(column.id, 1)}
                            disabled={last}
                            title='Déplacer à droite'
                            aria-label='Déplacer la colonne à droite'
                        >
                            <span className='icon icon-move-to-right' />
                        </button>
                        <button
                            type='button'
                            onClick={() => onEdit(column)}
                            title='Modifier la colonne'
                            aria-label='Modifier la colonne'
                        >
                            <span className='icon icon-settings' />
                        </button>
                    </span>
                )}
            </header>

            <div ref={setNodeRef} className={`${styles.columnBody} ${isOver ? styles.columnOver : ''}`}>
                <SortableContext items={ids} strategy={verticalListSortingStrategy}>
                    {cards.map((card) => (
                        <SortableCard
                            key={card.id}
                            card={card}
                            members={members}
                            outline={outlineFor(`card:${card.id}`)}
                            onOpen={() => onCardOpen(card)}
                        />
                    ))}
                </SortableContext>
                {cards.length === 0 && <p className={styles.columnEmpty}>Aucune carte</p>}
            </div>

            {canWrite && (
                <Button variant='ghost' icon='add' onClick={() => onCardCreate(column.id)}>
                    Carte
                </Button>
            )}
        </section>
    );
}

interface SortableCardProps {
    card: ProjectCard;
    members: MinimalUser[];
    outline: LiveOutlineProps;
    onOpen: () => void;
}

function SortableCard({ card, members, outline, onOpen }: SortableCardProps) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: card.id });
    const style = {
        transform: CSS.Translate.toString(transform),
        transition,
        // framer-motion n'intervient pas ici, mais on reste sur `filter` par
        // cohérence avec le reste de la feature.
        filter: isDragging ? 'opacity(0.35)' : undefined
    };

    return (
        <div ref={setNodeRef} style={style} {...attributes} {...listeners} {...outline}>
            <CardBody card={card} members={members} onOpen={onOpen} />
        </div>
    );
}

interface CardBodyProps {
    card: ProjectCard;
    members: MinimalUser[];
    dragging?: boolean;
    onOpen?: () => void;
}

function CardBody({ card, members, dragging, onOpen }: CardBodyProps) {
    const assignee = members.find((m) => m.id === card.assigneeUserId);
    const due = formatDate(card.dueDate);
    const overdue = card.dueDate !== null && card.dueDate * 1000 < Date.now();
    const done = card.checklist.filter((i) => i.done).length;

    return (
        <article
            className={`${styles.card2} ${dragging ? styles.card2Dragging : ''}`}
            onClick={onOpen}
            role={onOpen ? 'button' : undefined}
            tabIndex={onOpen ? 0 : undefined}
            onKeyDown={(e) => {
                if (!onOpen) return;
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onOpen();
                }
            }}
        >
            <div className={styles.card2Top}>
                {card.priority !== 'none' && (
                    <span
                        className={styles.priority}
                        data-priority={card.priority}
                        title={`Priorité ${PRIORITY_LABELS[card.priority].toLowerCase()}`}
                    />
                )}
                <span className={styles.card2Title}>{card.title || 'Sans titre'}</span>
                {/* Badge visible uniquement quand il y a réellement du non-lu. */}
                {card.unread > 0 && <span className={styles.unread}>{card.unread}</span>}
            </div>

            <div className={styles.card2Meta}>
                {card.checklist.length > 0 && (
                    <span>
                        <span className='icon icon-square-check' /> {done}/{card.checklist.length}
                    </span>
                )}
                {card.messageCount > 0 && (
                    <span>
                        <span className='icon icon-notes' /> {card.messageCount}
                    </span>
                )}
                {due && <span className={overdue ? styles.overdue : undefined}>{due}</span>}
                <span className={styles.card2Spacer} />
                {card.assigneeUserId !== null && <Avatar user={assignee} size={20} />}
            </div>
        </article>
    );
}

export default Board;
