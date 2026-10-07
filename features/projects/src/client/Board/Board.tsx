import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type ButtonHTMLAttributes,
    type PointerEvent as ReactPointerEvent
} from 'react';
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
import {
    Button,
    CountBadge,
    type LiveOutlineProps,
    SearchSelect,
    TextInput,
    useDragReorder,
    useLiveOutlines,
    useRequestPopupWidth,
    useWorkspaceMembers
} from 'deveye-sdk-client';
import { formatDate, PRIORITY_LABELS } from '../api';
import type { ProjectCard, ProjectColumn, ProjectMilestone } from '../../contracts/domain';
import { MilestoneDot, milestoneOf } from '../Milestone';
import { MemberStack } from '../Member';
import type { CardTab } from './CardDialog';
import { cardSearch, orderWithHidden } from './search';
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
    /** L'ordre complet des colonnes après un glissé de poignée. */
    onColumnsReorder: (columnIds: number[]) => void;
    onColumnCreate: () => void;
    /** Archive d'un coup les cartes d'une colonne terminée. */
    onColumnPurge: (column: ProjectColumn) => void;
    /** Les jalons du projet : la carte montre celui qu'elle porte. */
    milestones: ProjectMilestone[];
    /**
     * Le jalon mis en avant ; `null` = aucun, toutes les tâches à plein. Un objet
     * neuf à chaque choix, même répété : c'est lui qui relance le défilement.
     */
    focus: { milestoneId: number } | null;
    /** La recherche du champ d'en-tête ; vide, toutes les tâches paraissent. */
    search: string;
}

/**
 * Le kanban, sur dnd-kit. La carte rejoint la colonne survolée dès qu'elle y
 * entre (`onDragOver`) et non au lâcher, pour que les voisines s'écartent et que
 * la colonne d'origine se referme. Les colonnes, elles, se réordonnent par leur
 * poignée, sur `useDragReorder` et hors du DndContext : un second niveau de tri
 * dans le même contexte coûte cher en cas limites, et les deux gestes ne peuvent
 * pas se croiser, un pointeur ne tenant qu'une chose à la fois.
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
    onColumnsReorder,
    onColumnCreate,
    onColumnPurge,
    milestones,
    focus,
    search
}: BoardProps) {
    const [activeId, setActiveId] = useState<number | null>(null);
    /** D'où la carte est partie, pour la remettre en place sur Échap. */
    const origin = useRef<{ columnId: number; index: number } | null>(null);
    // `l3` : l'onglet du projet occupe `l2` (voir `ProjectDetail`).
    const outlineFor = useLiveOutlines('l3');

    /**
     * Réordonner les colonnes à la poignée. La piste porte la barre d'insertion :
     * posée en absolu, elle doit l'être dans une boîte qui défile avec le contenu,
     * là où le cadre défilant la décalerait de son `scrollLeft`.
     */
    const columnDrag = useDragReorder<HTMLDivElement, HTMLDivElement>({
        ids: columns.map((c) => c.id),
        rowSelector: '[data-board-column]',
        layout: 'grid',
        onReorder: (ids) => onColumnsReorder(ids as number[]),
        onDragStateChange
    });

    /**
     * Le tableau réclame à la popup la largeur de ses colonnes, de la première au
     * bouton d'ajout : mesurée sur elles et non sur le tableau, dont la boîte suit
     * la popup. La demande est relâchée au démontage, donc en quittant l'onglet.
     *
     * Par union des boîtes et non par les deux bouts : la barre d'insertion est
     * hors flux et ne doit pas passer pour la dernière colonne.
     */
    const trackRef = columnDrag.listRef;
    const [columnsWidth, setColumnsWidth] = useState<number | null>(null);
    useLayoutEffect(() => {
        const track = trackRef.current;
        if (!track) return;
        const measure = () => {
            let left = Infinity;
            let right = -Infinity;
            for (const child of track.children) {
                const el = child as HTMLElement;
                left = Math.min(left, el.offsetLeft);
                right = Math.max(right, el.offsetLeft + el.offsetWidth);
            }
            setColumnsWidth(right > left ? right - left : null);
        };
        measure();
        const ro = new ResizeObserver(measure);
        for (const child of track.children) ro.observe(child);
        return () => ro.disconnect();
    }, [trackRef, columns.length, canManage]);
    useRequestPopupWidth(columnsWidth === null ? null : boardNaturalWidth(columnsWidth));

    /**
     * Choisir un jalon amène sa première tâche en haut de chaque colonne qui en
     * porte une : plus bas, rien ne paraîtrait en avant. Colonne par colonne, là où
     * `scrollIntoView` ferait aussi défiler le tableau en travers.
     */
    useEffect(() => {
        const track = trackRef.current;
        if (focus === null || !track) return;
        const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
        for (const body of track.querySelectorAll<HTMLElement>('[data-column-body]')) {
            const target = body.querySelector<HTMLElement>(`[data-milestone="${focus.milestoneId}"]`);
            const first = body.firstElementChild as HTMLElement | null;
            if (!target || !first) continue;
            // L'écart à la première carte : `offsetTop` ignore les décalages du tri.
            body.scrollTo({ top: target.offsetTop - first.offsetTop, behavior });
        }
    }, [focus, trackRef]);

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

    /**
     * Les cartes que la recherche laisse paraître. Le glisser ne voit qu'elles, et
     * `withHidden` remet les autres dans l'ordre que le dépôt renvoie : il réécrit
     * toute la colonne.
     */
    const members = useWorkspaceMembers();
    const matches = useMemo(() => cardSearch(search, members), [search, members]);
    const shown = useMemo(() => {
        if (matches === null) return byColumn;
        const map = new Map<number, ProjectCard[]>();
        for (const [columnId, list] of byColumn) map.set(columnId, list.filter(matches));
        return map;
    }, [byColumn, matches]);
    const found = matches === null ? null : [...shown.values()].reduce((n, list) => n + list.length, 0);

    const withHidden = (columnId: number, ids: number[], moved: number) =>
        orderWithHidden(
            (byColumn.get(columnId) ?? []).map((c) => c.id),
            ids,
            moved
        );

    const activeCard = activeId === null ? null : (cards.find((c) => c.id === activeId) ?? null);
    const activeColumnDone = columns.find((c) => c.id === activeCard?.columnId)?.countsAsDone ?? false;

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
            for (const card of shown.get(columnId) ?? []) {
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
        [shown]
    );

    const locate = (cardId: number) => {
        const card = cards.find((c) => c.id === cardId);
        if (!card || card.columnId === null) return null;
        const list = shown.get(card.columnId) ?? [];
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

        const target = shown.get(targetColumn) ?? [];
        const at = hasSortableData(over) ? over.data.current.sortable.index : target.length;
        const nextIds = [...target.map((c) => c.id)];
        nextIds.splice(at, 0, activeCardId);
        onCardsPreview(applyOrder(cards, targetColumn, withHidden(targetColumn, nextIds, activeCardId)));
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

        const list = shown.get(targetColumn) ?? [];
        const ids = list.map((c) => c.id);
        // Les index sont ceux que la liste triée a peints : le dépôt ne peut pas
        // contredire l'aperçu. Une colonne pour cible veut dire qu'elle est vide,
        // ou que la carte y est seule.
        const from = ids.indexOf(cardId);
        const to = hasSortableData(over) ? over.data.current.sortable.index : ids.length - 1;
        const nextIds = from >= 0 && to >= 0 && from !== to ? arrayMove(ids, from, to) : ids;

        const unmoved = back !== null && back.columnId === targetColumn && back.index === nextIds.indexOf(cardId);
        if (unmoved) return;
        const order = withHidden(targetColumn, nextIds, cardId);
        onCardsMoved(targetColumn, order, applyOrder(cards, targetColumn, order));
    };

    /** Remet l'aperçu comme avant le geste, sans rien écrire. */
    const restore = (back: { columnId: number; index: number } | null, id: number) => {
        if (!back) return;
        const list = (shown.get(back.columnId) ?? []).map((c) => c.id).filter((c) => c !== id);
        list.splice(back.index, 0, id);
        onCardsPreview(applyOrder(cards, back.columnId, withHidden(back.columnId, list, id)));
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
            {found === 0 && (
                <p className={styles.boardNoMatch} role='status'>
                    Aucune tâche ne correspond à « {search.trim()} ».
                </p>
            )}
            <div className={styles.board}>
                <div ref={trackRef} className={styles.boardTrack}>
                    {columns.map((column) => (
                        <Column
                            key={column.id}
                            column={column}
                            cards={shown.get(column.id) ?? []}
                            count={byColumn.get(column.id)?.length ?? 0}
                            canWrite={canWrite}
                            canTasks={canTasks}
                            canManage={canManage}
                            outlineFor={outlineFor}
                            onCardOpen={onCardOpen}
                            onCardCreate={onCardCreate}
                            onEdit={onColumnEdit}
                            onPurge={onColumnPurge}
                            milestone={(card) => milestoneOf(milestones, card.milestoneId)}
                            // Les tâches des autres jalons s'estompent, aucune ne
                            // quitte sa colonne : un vrai filtre les retirerait de
                            // l'ordre que le dépôt renvoie, et les ferait remonter à
                            // la fin de leur colonne.
                            dimmed={(card) => focus !== null && card.milestoneId !== focus.milestoneId}
                            // Seule d'elle-même, une colonne n'a nulle part où aller.
                            onDragPointerDown={
                                canManage && columns.length > 1
                                    ? (e) => columnDrag.onGripPointerDown(e, column.id)
                                    : undefined
                            }
                        />
                    ))}
                    {canManage && (
                        <button type='button' className={styles.addColumn} onClick={onColumnCreate}>
                            <span className='icon icon-add' /> Colonne
                        </button>
                    )}
                    <div ref={columnDrag.barRef} className={styles.dropBar} aria-hidden='true' />
                </div>
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
                    {activeCard && (
                        <CardBody
                            card={activeCard}
                            columnDone={activeColumnDone}
                            milestone={milestoneOf(milestones, activeCard.milestoneId)}
                            dragging
                        />
                    )}
                </DragOverlay>,
                document.body
            )}
        </DndContext>
    );
}

interface MilestoneFocusProps {
    milestones: ProjectMilestone[];
    value: number | null;
    onChange: (milestoneId: number | null) => void;
}

/** Le choix du jalon mis en avant, posé par la fiche dans sa rangée d'en-tête. */
export function MilestoneFocus({ milestones, value, onChange }: MilestoneFocusProps) {
    return (
        <div className={styles.boardFilter}>
            <span className={styles.boardFilterLabel}>Jalon</span>
            <SearchSelect
                aria-label='Mettre un jalon en avant'
                className={styles.boardFilterSelect}
                value={value === null ? '' : String(value)}
                options={[
                    { value: '', label: 'Tous', prefix: <MilestoneDot color={null} /> },
                    ...milestones.map((m) => ({
                        value: String(m.id),
                        label: m.name || `Jalon #${m.id}`,
                        prefix: <MilestoneDot color={m.color} />
                    }))
                ]}
                onChange={(v) => onChange(v ? Number(v) : null)}
            />
        </div>
    );
}

interface BoardSearchProps {
    value: string;
    onChange: (value: string) => void;
}

/** La recherche du tableau, posée par la fiche à côté du choix du jalon. */
export function BoardSearch({ value, onChange }: BoardSearchProps) {
    return (
        <div className={styles.boardSearch}>
            <span className={`icon icon-search ${styles.boardSearchIcon}`} aria-hidden='true' />
            {/* `text` et non `search` : la croix est celle du SDK, et un champ de
                recherche en dessinerait une seconde sous Chrome. */}
            <TextInput
                type='text'
                role='searchbox'
                className={styles.boardSearchInput}
                value={value}
                placeholder='Rechercher une tâche'
                title='Titre, description, sous-tâches ou participants'
                aria-label='Rechercher une tâche par son titre, sa description, ses sous-tâches ou ses participants'
                onChange={(e) => onChange(e.target.value)}
                onClear={() => onChange('')}
            />
        </div>
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
    /** Celles que la recherche laisse paraître. */
    cards: ProjectCard[];
    /** Toutes celles de la colonne : la limite de travail en cours les compte. */
    count: number;
    canWrite: boolean;
    canTasks: boolean;
    canManage: boolean;
    outlineFor: (value: string | null) => LiveOutlineProps;
    onCardOpen: (card: ProjectCard, tab: CardTab) => void;
    onCardCreate: (columnId: number) => void;
    onEdit: (column: ProjectColumn) => void;
    onPurge: (column: ProjectColumn) => void;
    milestone: (card: ProjectCard) => ProjectMilestone | null;
    dimmed: (card: ProjectCard) => boolean;
    /** Absent : la colonne ne se déplace pas, faute de droit ou de voisine. */
    onDragPointerDown?: (e: ReactPointerEvent) => void;
}

function Column({
    column,
    cards,
    count,
    canWrite,
    canTasks,
    canManage,
    outlineFor,
    onCardOpen,
    onCardCreate,
    onEdit,
    onPurge,
    milestone,
    dimmed,
    onDragPointerDown
}: ColumnProps) {
    // Droppable propre à la colonne : c'est ce qui rend une colonne vide capable
    // de recevoir une carte.
    const { setNodeRef, isOver } = useDroppable({ id: `col:${column.id}` });
    const ids = cards.map((c) => c.id);
    // La limite est indicative : on la signale, on ne refuse jamais le dépôt.
    const overLimit = column.wipLimit !== null && count > column.wipLimit;

    return (
        <section className={styles.column} data-board-column=''>
            <header className={styles.columnHead}>
                {onDragPointerDown && (
                    <button
                        type='button'
                        className={styles.columnGrip}
                        title='Déplacer cette colonne'
                        aria-label={`Réordonner ${column.name || 'cette colonne'}`}
                        onPointerDown={onDragPointerDown}
                    >
                        <span className='icon icon-drag' />
                    </button>
                )}
                {/* Le nom est abrégé par la largeur fixe de la colonne : l'infobulle
                    est le seul endroit où un intitulé long se lit en entier. */}
                <span className={styles.columnName} title={column.name || 'Sans nom'}>
                    {column.name || 'Sans nom'}
                </span>
                <span className={overLimit ? styles.columnCountOver : styles.columnCount}>
                    {count}
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
                        {/* Vider la colonne : le geste de la fin d'un cycle, à portée
                            de main plutôt qu'enfoui dans les réglages. Absent d'une
                            colonne vide, qui n'a rien à archiver. */}
                        {canTasks && column.countsAsDone && count > 0 && (
                            <button
                                type='button'
                                onClick={() => onPurge(column)}
                                title='Archiver les tâches de cette colonne'
                                aria-label='Archiver les tâches de cette colonne'
                            >
                                <span className='icon icon-archive' />
                            </button>
                        )}
                        {canManage && (
                            <button
                                type='button'
                                onClick={() => onEdit(column)}
                                title='Modifier la colonne'
                                aria-label='Modifier la colonne'
                            >
                                <span className='icon icon-settings' />
                            </button>
                        )}
                    </span>
                )}
            </header>

            <div
                ref={setNodeRef}
                className={`${styles.columnBody} ${isOver ? styles.columnOver : ''}`}
                data-column-body=''
            >
                <SortableContext id={`col:${column.id}`} items={ids} strategy={verticalListSortingStrategy}>
                    {cards.map((card) => (
                        <SortableCard
                            key={card.id}
                            card={card}
                            columnDone={column.countsAsDone}
                            milestone={milestone(card)}
                            dimmed={dimmed(card)}
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
    columnDone: boolean;
    milestone: ProjectMilestone | null;
    /** Un autre jalon est mis en avant : la carte s'efface sans quitter sa colonne. */
    dimmed: boolean;
    /** Sans l'écriture, la carte s'ouvre mais ne se déplace pas. */
    draggable: boolean;
    outline: LiveOutlineProps;
    onOpen: (tab: CardTab) => void;
}

function SortableCard({ card, columnDone, milestone, dimmed, draggable, outline, onOpen }: SortableCardProps) {
    const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
        id: card.id,
        disabled: !draggable
    });
    const style = {
        transform: CSS.Translate.toString(transform),
        transition,
        // `filter` et non `opacity` : dans le reste de la feature, c'est
        // framer-motion qui possède l'opacité.
        filter: isDragging ? 'opacity(0.35)' : dimmed ? 'opacity(0.3)' : undefined
    };

    // Le pointeur saisit la carte n'importe où, puces comprises. Le clavier, lui,
    // part du bouton d'ouverture : c'est l'activateur que son capteur exige, et le
    // seul élément de la carte à porter le rôle de ce qui se trie.
    return (
        <div ref={setNodeRef} style={style} data-milestone={card.milestoneId ?? undefined} {...listeners} {...outline}>
            <CardBody
                card={card}
                columnDone={columnDone}
                milestone={milestone}
                onOpen={onOpen}
                opener={{ ref: setActivatorNodeRef, ...attributes }}
            />
        </div>
    );
}

interface CardBodyProps {
    card: ProjectCard;
    /** La colonne vaut « terminé » : une échéance passée n'y est plus un retard. */
    columnDone: boolean;
    /** Le jalon de la carte, montré en puce ; `null` quand elle n'en porte pas. */
    milestone: ProjectMilestone | null;
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
function CardBody({ card, columnDone, milestone, dragging, onOpen, opener }: CardBodyProps) {
    const due = formatDate(card.dueDate);
    const overdue = !columnDone && card.dueDate !== null && card.dueDate * 1000 < Date.now();
    const done = card.checklist.filter((i) => i.done).length;
    const held = card.checklist.filter((i) => i.required && !i.done).length;
    const title = card.title || 'Sans titre';

    const checkChip = (
        <>
            <span className={`icon icon-square-check ${styles.chipIcon}`} />
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
                {/* Le jalon au coin, en pendant de la pastille de priorité. Son nom
                    cède le pas au titre : il s'abrège, et l'infobulle le rend entier. */}
                {milestone && (
                    <span className={styles.card2Milestone} title={`Jalon : ${milestone.name || 'Sans nom'}`}>
                        <MilestoneDot color={milestone.color} />
                        <span className={styles.card2MilestoneName}>{milestone.name || 'Sans nom'}</span>
                    </span>
                )}
            </div>

            {/* Bornée à trois lignes par le CSS : de quoi reconnaître une tâche
                sans l'ouvrir. */}
            {card.description && <p className={styles.card2Desc}>{card.description}</p>}

            {/* Les deux puces sont là quelle que soit leur valeur, et la copie
                flottante porte les mêmes : une carte saisie doit rester la carte
                qu'on vient de quitter. */}
            <div className={styles.card2Meta}>
                {onOpen ? (
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
                    <span className={styles.card2ChipStatic} data-held={held > 0 ? '' : undefined}>
                        {checkChip}
                    </span>
                )}
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
                    <span className={styles.card2ChipStatic}>{chatChip}</span>
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
