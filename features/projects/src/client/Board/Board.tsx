import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ButtonHTMLAttributes } from 'react';
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
    hasSortableData,
    sortableKeyboardCoordinates,
    useSortable,
    verticalListSortingStrategy
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Button, CountBadge, type LiveOutlineProps, useLiveOutlines, useRequestPopupWidth } from 'deveye-sdk-client';
import { formatDate, PRIORITY_LABELS } from '../api';
import type { ProjectCard, ProjectColumn } from '../../contracts/domain';
import { MemberStack } from '../Member';
import type { CardTab } from './CardDialog';
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
    /** L'aperçu d'un glissé en cours : local, rien ne part au serveur. */
    onCardsPreview: (next: ProjectCard[]) => void;
    /** Un glissé commence ou finit : l'appelant retient ses relectures, qui déferaient l'aperçu. */
    onDragStateChange: (dragging: boolean) => void;
    /** Le dépôt : une seule écriture par geste, l'ordre complet de la colonne d'arrivée. */
    onCardsMoved: (columnId: number, cardIds: number[], next: ProjectCard[]) => void;
    /** `tab` : l'onglet que le geste vise (le corps, la puce du suivi, celle du fil). */
    onCardOpen: (card: ProjectCard, tab: CardTab) => void;
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
    onCardsPreview,
    onDragStateChange,
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

    /**
     * Le tableau réclame à la popup la largeur de ses colonnes, de la première à
     * la dernière : mesurée sur elles et non sur le tableau, dont la boîte suit la
     * popup. La demande est relâchée au démontage, donc en quittant l'onglet.
     */
    const boardRef = useRef<HTMLDivElement>(null);
    const [columnsWidth, setColumnsWidth] = useState<number | null>(null);
    useLayoutEffect(() => {
        const board = boardRef.current;
        if (!board) return;
        const measure = () => {
            const first = board.firstElementChild as HTMLElement | null;
            const last = board.lastElementChild as HTMLElement | null;
            setColumnsWidth(first && last ? last.offsetLeft + last.offsetWidth - first.offsetLeft : null);
        };
        measure();
        const ro = new ResizeObserver(measure);
        for (const child of board.children) ro.observe(child);
        return () => ro.disconnect();
    }, [columns.length, canManage]);
    useRequestPopupWidth(columnsWidth === null ? null : boardNaturalWidth(columnsWidth));

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

    /**
     * La colonne contient ses cartes : dans la gouttière qui les sépare, elle seule
     * répond au pointeur. Or elle n'est pas un élément de la liste triée, qui
     * peindrait alors le trou d'atterrissage en tête de colonne. On vise donc
     * toujours une carte, la plus proche du pointeur, et la colonne seulement vide.
     */
    const collisionDetection = useCallback<CollisionDetection>(
        (args) => {
            const within = pointerWithin(args);
            const hits = within.length > 0 ? within : closestCenter(args);
            const direct = hits.find((h) => !String(h.id).startsWith('col:'));
            if (direct) return [direct];
            const column = hits[0];
            const pointerY = args.pointerCoordinates?.y;
            if (!column || pointerY === undefined) return hits;

            const columnId = Number(String(column.id).slice(4));
            let nearest: { id: number; distance: number } | null = null;
            for (const card of byColumn.get(columnId) ?? []) {
                if (card.id === args.active.id) continue;
                const rect = args.droppableRects.get(card.id);
                if (!rect) continue;
                const distance = Math.abs(rect.top + rect.height / 2 - pointerY);
                if (nearest === null || distance < nearest.distance) nearest = { id: card.id, distance };
            }
            if (nearest === null) return [column];
            const container = args.droppableContainers.find((c) => c.id === nearest?.id);
            return container ? [{ id: nearest.id, data: { droppableContainer: container, value: 0 } }] : [column];
        },
        [byColumn]
    );

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
        onDragStateChange(true);
    };

    /** Reclasse localement pendant le survol : rien ne part avant le dépôt. */
    const onDragOver = (e: DragOverEvent) => {
        const { active, over } = e;
        if (!over || activeId === null) return;
        const activeCardId = Number(active.id);
        const targetColumn = columnOf(String(over.id));
        if (targetColumn === null) return;
        const current = cards.find((c) => c.id === activeCardId);
        if (!current || current.columnId === targetColumn) return;

        const target = byColumn.get(targetColumn) ?? [];
        const at = hasSortableData(over) ? over.data.current.sortable.index : target.length;
        const nextIds = [...target.map((c) => c.id)];
        nextIds.splice(at, 0, activeCardId);
        onCardsPreview(applyOrder(cards, targetColumn, nextIds));
    };

    const onDragEnd = (e: DragEndEvent) => {
        const { active, over } = e;
        const back = origin.current;
        setActiveId(null);
        origin.current = null;
        onDragStateChange(false);
        if (!over) {
            restore(back, Number(active.id));
            return;
        }

        const cardId = Number(active.id);
        const card = cards.find((c) => c.id === cardId);
        if (!card) return;
        const targetColumn = columnOf(String(over.id));
        if (targetColumn === null) return;

        const list = byColumn.get(targetColumn) ?? [];
        const ids = list.map((c) => c.id);
        // Les index sont ceux que la liste triée a peints : le dépôt ne peut pas
        // contredire l'aperçu. Une colonne pour cible veut dire qu'elle est vide,
        // ou que la carte y est seule.
        const from = ids.indexOf(cardId);
        const to = hasSortableData(over) ? over.data.current.sortable.index : ids.length - 1;
        const nextIds = from >= 0 && to >= 0 && from !== to ? arrayMove(ids, from, to) : ids;

        const unmoved = back !== null && back.columnId === targetColumn && back.index === nextIds.indexOf(cardId);
        if (unmoved) return;
        onCardsMoved(targetColumn, nextIds, applyOrder(cards, targetColumn, nextIds));
    };

    /** Remet l'aperçu comme avant le geste, sans rien écrire. */
    const restore = (back: { columnId: number; index: number } | null, id: number) => {
        if (!back) return;
        const list = (byColumn.get(back.columnId) ?? []).map((c) => c.id).filter((c) => c !== id);
        list.splice(back.index, 0, id);
        onCardsPreview(applyOrder(cards, back.columnId, list));
    };

    /** Échap en cours de glisser : la carte retourne d'où elle vient. */
    const onDragCancel = () => {
        const back = origin.current;
        const id = activeId;
        setActiveId(null);
        origin.current = null;
        onDragStateChange(false);
        if (id !== null) restore(back, id);
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
            <div ref={boardRef} className={styles.board}>
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
    onCardOpen: (card: ProjectCard, tab: CardTab) => void;
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
                <SortableContext id={`col:${column.id}`} items={ids} strategy={verticalListSortingStrategy}>
                    {cards.map((card) => (
                        <SortableCard
                            key={card.id}
                            card={card}
                            draggable={canWrite}
                            outline={outlineFor(`card:${card.id}`)}
                            onOpen={(tab) => onCardOpen(card, tab)}
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
    onOpen: (tab: CardTab) => void;
}

function SortableCard({ card, draggable, outline, onOpen }: SortableCardProps) {
    const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
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

    // Le pointeur saisit la carte n'importe où, puces comprises. Le clavier, lui,
    // part du bouton d'ouverture : c'est l'activateur que son capteur exige, et le
    // seul élément de la carte à porter le rôle de ce qui se trie.
    return (
        <div ref={setNodeRef} style={style} {...listeners} {...outline}>
            <CardBody card={card} onOpen={onOpen} opener={{ ref: setActivatorNodeRef, ...attributes }} />
        </div>
    );
}

interface CardBodyProps {
    card: ProjectCard;
    dragging?: boolean;
    onOpen?: (tab: CardTab) => void;
    /** Ce que le tri pose sur le bouton d'ouverture. */
    opener?: ButtonHTMLAttributes<HTMLButtonElement> & { ref: (node: HTMLElement | null) => void };
}

/**
 * La carte s'ouvre par trois gestes. Un bouton étiré sous le contenu porte
 * l'ouverture par défaut ; les puces, ses sœurs posées au-dessus, portent les deux
 * autres. Aucun bouton n'en contient un autre.
 */
function CardBody({ card, dragging, onOpen, opener }: CardBodyProps) {
    const due = formatDate(card.dueDate);
    const overdue = card.dueDate !== null && card.dueDate * 1000 < Date.now();
    const done = card.checklist.filter((i) => i.done).length;
    const held = card.checklist.filter((i) => i.required && !i.done).length;
    const title = card.title || 'Sans titre';

    const checkChip = (
        <>
            <span className={`icon icon-square-check ${styles.chipIcon} ${styles.chipCheck}`} />
            {card.checklist.length > 0 ? `${done}/${card.checklist.length}` : 0}
        </>
    );
    const chatChip = (
        <>
            <span
                className={`icon icon-chat-outline ${styles.chipIcon} ${card.unread > 0 ? styles.chipIconHot : ''}`}
            />
            {card.messageCount}
        </>
    );
    const checkTitle =
        held > 0
            ? `${held} sous-tâche${held > 1 ? 's' : ''} obligatoire${held > 1 ? 's' : ''} à terminer`
            : `Sous-tâches : ${done} sur ${card.checklist.length}`;

    return (
        <article className={`${styles.card2} ${dragging ? styles.card2Dragging : ''}`}>
            {onOpen && (
                <button
                    type='button'
                    className={styles.card2Open}
                    aria-label={`Ouvrir ${title}`}
                    onClick={() => onOpen('settings')}
                    {...opener}
                />
            )}

            <div className={styles.card2Top}>
                {card.priority !== 'none' && (
                    <span
                        className={styles.priority}
                        data-priority={card.priority}
                        title={`Priorité ${PRIORITY_LABELS[card.priority].toLowerCase()}`}
                    />
                )}
                <span className={styles.card2Title}>{title}</span>
                {card.unread > 0 && (
                    <CountBadge count={card.unread} aria-label={`${card.unread} non lu${card.unread > 1 ? 's' : ''}`} />
                )}
            </div>

            {/* Bornée à trois lignes par le CSS : de quoi reconnaître une tâche
                sans l'ouvrir. */}
            {card.description && <p className={styles.card2Desc}>{card.description}</p>}

            <div className={styles.card2Meta}>
                {(onOpen || card.checklist.length > 0) &&
                    (onOpen ? (
                        <button
                            type='button'
                            className={styles.card2ChipButton}
                            data-held={held > 0 ? '' : undefined}
                            title={checkTitle}
                            aria-label={`Ouvrir le suivi. ${checkTitle}`}
                            onClick={() => onOpen('work')}
                        >
                            {checkChip}
                        </button>
                    ) : (
                        <span className={styles.card2Chip}>{checkChip}</span>
                    ))}
                {onOpen ? (
                    <button
                        type='button'
                        className={styles.card2ChipButton}
                        title='Ouvrir la discussion'
                        aria-label={`Ouvrir la discussion, ${card.messageCount} message${card.messageCount > 1 ? 's' : ''}${
                            card.unread > 0 ? `, ${card.unread} non lu${card.unread > 1 ? 's' : ''}` : ''
                        }`}
                        onClick={() => onOpen('chat')}
                    >
                        {chatChip}
                    </button>
                ) : (
                    card.messageCount > 0 && <span className={styles.card2Chip}>{chatChip}</span>
                )}
                {due && <span className={overdue ? styles.overdue : undefined}>{due}</span>}
                <span className={styles.card2Spacer} />
                <MemberStack
                    userId={card.assigneeUserId}
                    others={card.checklist.map((i) => i.assigneeUserId)}
                    size={20}
                    spread
                />
            </div>
        </article>
    );
}

export default Board;
