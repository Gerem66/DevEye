import { useCallback, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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
import { Button, useLiveOutlines, useRequestPopupWidth, type LiveOutlineProps } from 'deveye-sdk-client';
import { formatDate, PRIORITY_LABELS } from '../api';
import type { ProjectCard, ProjectColumn } from '../../contracts/domain';
import { MemberAvatar } from '../Member';
import { boardNaturalWidth } from './width';
import styles from '../style.module.css';

interface BoardProps {
    columns: ProjectColumn[];
    cards: ProjectCard[];
    /** Déplacer une carte d'une colonne à l'autre, et l'ouvrir pour la retoucher. */
    canWrite: boolean;
    /** Créer une tâche. */
    canTasks: boolean;
    /** Tenir les colonnes. */
    canManage: boolean;
    /** Applique un nouvel ordre localement (optimiste) puis le persiste. */
    onCardsMoved: (columnId: number, cardIds: number[], next: ProjectCard[]) => void;
    onCardOpen: (card: ProjectCard) => void;
    onCardCreate: (columnId: number) => void;
    onColumnEdit: (column: ProjectColumn) => void;
    onColumnMove: (columnId: number, direction: -1 | 1) => void;
    onColumnCreate: () => void;
}

/**
 * Le kanban, sur dnd-kit. La carte rejoint la colonne survolée dès qu'elle y
 * entre (`onDragOver`) et non au lâcher, pour que les voisines s'écartent et que
 * la colonne d'origine se referme. Les colonnes, elles, se réordonnent par des
 * flèches : un second niveau de tri dans le même DndContext coûte cher en cas
 * limites. `nativeDrag.ts` neutralisant les glissers HTML5 natifs de
 * l'application, un `draggable` maison serait mort-né ici.
 */
export function Board({
    columns,
    cards,
    canWrite,
    canTasks,
    canManage,
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
    // `l3` : l'onglet du projet occupe `l2` (voir `ProjectDetail`).
    const outlineFor = useLiveOutlines('l3');

    // Le tableau réclame à la popup la largeur exacte de ses colonnes ; la
    // demande est relâchée au démontage, donc en quittant l'onglet.
    useRequestPopupWidth(boardNaturalWidth(columns.length, canManage));

    const sensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
        useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
    );

    const byColumn = useMemo(() => {
        const map = new Map<number, ProjectCard[]>();
        for (const column of columns) map.set(column.id, []);
        for (const card of cards) {
            if (card.columnId === null) continue;
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
        // `pointerWithin` d'abord : lui seul distingue une colonne vide survolée.
        const pointer = pointerWithin(args);
        return pointer.length > 0 ? pointer : closestCenter(args);
    }, []);

    const locate = (cardId: number) => {
        const card = cards.find((c) => c.id === cardId);
        if (!card || card.columnId === null) return null;
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
        const overId = String(over.id);
        const targetColumn = columnOf(overId);
        if (targetColumn === null) return;

        const list = byColumn.get(targetColumn) ?? [];
        const from = list.findIndex((c) => c.id === cardId);
        // Sous la dernière carte, le curseur n'en survole plus aucune : c'est la
        // colonne qui répond, et « sous toutes » veut dire à la fin. Sans ce cas,
        // la carte resterait là où son entrée dans la colonne l'avait posée.
        const to = overId.startsWith('col:') ? list.length - 1 : list.findIndex((c) => c.id === Number(overId));
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
                        canWrite={canWrite}
                        canTasks={canTasks}
                        canManage={canManage}
                        first={index === 0}
                        last={index === columns.length - 1}
                        outlineFor={outlineFor}
                        onCardOpen={onCardOpen}
                        onCardCreate={onCardCreate}
                        onEdit={onColumnEdit}
                        onMove={onColumnMove}
                    />
                ))}
                {canManage && (
                    <button type='button' className={styles.addColumn} onClick={onColumnCreate}>
                        <span className='icon icon-add' /> Colonne
                    </button>
                )}
            </div>

            {/* La copie flottante est en `position: fixed`, et le `backdrop-filter`
                de la popup fait d'elle le bloc conteneur de tout descendant fixé :
                rendue ici, la copie serait posée par rapport au coin de la popup et
                non de la fenêtre, soit à plusieurs dizaines de pixels du curseur.
                Dans le corps du document, ses coordonnées redeviennent celles que
                dnd-kit mesure. Elle reprend la carte sans son contour de présence :
                deux cadres superposés seraient illisibles. */}
            {createPortal(
                <DragOverlay style={{ zIndex: 'var(--z-drag)' }}>
                    {activeCard && <CardBody card={activeCard} dragging />}
                </DragOverlay>,
                document.body
            )}
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
    canWrite: boolean;
    canTasks: boolean;
    canManage: boolean;
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
    canWrite,
    canTasks,
    canManage,
    first,
    last,
    outlineFor,
    onCardOpen,
    onCardCreate,
    onEdit,
    onMove
}: ColumnProps) {
    // Droppable propre à la colonne : c'est ce qui rend une colonne vide capable
    // de recevoir une carte.
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
                {(canTasks || canManage) && (
                    <span className={styles.columnActions}>
                        {/* Doublon assumé de « Tâche » plus bas : dans une colonne
                            pleine, l'autre bouton est sous la ligne de flottaison. */}
                        {canTasks && (
                            <button
                                type='button'
                                onClick={() => onCardCreate(column.id)}
                                title='Ajouter une tâche'
                                aria-label='Ajouter une tâche'
                            >
                                <span className='icon icon-add' />
                            </button>
                        )}
                        {canManage && (
                            <>
                                <button
                                    type='button'
                                    onClick={() => onMove(column.id, -1)}
                                    disabled={first}
                                    title='Déplacer à gauche'
                                    aria-label='Déplacer la colonne à gauche'
                                >
                                    <span className='icon icon-move-to-left' />
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
                            </>
                        )}
                    </span>
                )}
            </header>

            <div ref={setNodeRef} className={`${styles.columnBody} ${isOver ? styles.columnOver : ''}`}>
                <SortableContext items={ids} strategy={verticalListSortingStrategy}>
                    {cards.map((card) => (
                        <SortableCard
                            key={card.id}
                            card={card}
                            draggable={canWrite}
                            outline={outlineFor(`card:${card.id}`)}
                            onOpen={() => onCardOpen(card)}
                        />
                    ))}
                </SortableContext>
                {canTasks && (
                    <Button variant='ghost' icon='add' onClick={() => onCardCreate(column.id)}>
                        Tâche
                    </Button>
                )}
            </div>
        </section>
    );
}

interface SortableCardProps {
    card: ProjectCard;
    /** Sans l'écriture, la carte s'ouvre mais ne se déplace pas. */
    draggable: boolean;
    outline: LiveOutlineProps;
    onOpen: () => void;
}

function SortableCard({ card, draggable, outline, onOpen }: SortableCardProps) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
        id: card.id,
        disabled: !draggable
    });
    const style = {
        transform: CSS.Translate.toString(transform),
        transition,
        // `filter` et non `opacity` : dans le reste de la feature, c'est
        // framer-motion qui possède l'opacité.
        filter: isDragging ? 'opacity(0.35)' : undefined
    };

    return (
        <div ref={setNodeRef} style={style} {...attributes} {...listeners} {...outline}>
            <CardBody card={card} onOpen={onOpen} />
        </div>
    );
}

interface CardBodyProps {
    card: ProjectCard;
    dragging?: boolean;
    onOpen?: () => void;
}

function CardBody({ card, dragging, onOpen }: CardBodyProps) {
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
                {card.unread > 0 && <span className={styles.unread}>{card.unread}</span>}
            </div>

            {/* Bornée à trois lignes par le CSS : de quoi reconnaître une tâche
                sans l'ouvrir. */}
            {card.description && <p className={styles.card2Desc}>{card.description}</p>}

            <div className={styles.card2Meta}>
                {card.checklist.length > 0 && (
                    <span className={styles.card2Chip}>
                        <span className={`icon icon-square-check ${styles.chipIcon}`} />
                        {done}/{card.checklist.length}
                    </span>
                )}
                {card.messageCount > 0 && (
                    <span className={styles.card2Chip}>
                        <span className={`icon icon-notes ${styles.chipIcon}`} />
                        {card.messageCount}
                    </span>
                )}
                {due && <span className={overdue ? styles.overdue : undefined}>{due}</span>}
                <span className={styles.card2Spacer} />
                {/* Masqué s'il n'est pas membre d'ici (projet projeté). */}
                {card.assigneeUserId !== null && <MemberAvatar userId={card.assigneeUserId} size={20} />}
            </div>
        </article>
    );
}

export default Board;
