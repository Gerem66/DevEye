import { useCallback, useMemo, useRef, useState } from 'react';
import {
    DndContext,
    DragOverlay,
    closestCenter,
    KeyboardSensor,
    MeasuringStrategy,
    PointerSensor,
    pointerWithin,
    useSensor,
    useSensors,
    type CollisionDetection,
    type DragEndEvent,
    type DragOverEvent,
    type DragStartEvent
} from '@dnd-kit/core';
import {
    arrayMove,
    SortableContext,
    sortableKeyboardCoordinates,
    useSortable,
    rectSortingStrategy,
    verticalListSortingStrategy,
    type SortingStrategy
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Device, HomeFeatureId, HomeSection, ShortcutItem } from 'deveye-types';

import { useDevices } from '@/stores/devices';
import {
    moveSectionItem,
    removeDevice,
    removeFeature,
    removeSection,
    removeShortcut,
    renameSection,
    setSectionCollapsed,
    setSectionCollapsible,
    setSectionOrder,
    transferSectionItem,
    useHomeLayout
} from '@/stores/homeLayout';
import Button from '@/Components/Button';
import { Dialog } from '@/Components/Dialog';
import { Widget } from '@/Components/Widget';
import { deviceTileVisual, featureTileVisual, shortcutTileVisual, type TileVisual } from '../tiles/tileVisual';
import { AddSectionDialog } from './AddSectionDialog';
import { AddTileDialog } from './AddTileDialog';
import { ADD_TILE_LABEL, SECTION_KIND_LABEL } from './sectionKinds';
import styles from './organize.module.css';

/** A shortcut being edited, with the section it belongs to. */
interface ShortcutEdit {
    sectionId: string;
    item: ShortcutItem;
}

/**
 * The usual grid sorting, but inert for a section the drag has nothing to do with
 * — the one the tile just left, or one whose kind rejects it. `overIndex` is -1
 * there, which the default strategy reads as a move and would answer by shuffling
 * that section's own tiles for nothing.
 */
const sortInSection: SortingStrategy = (args) => (args.overIndex < 0 ? null : rectSortingStrategy(args));

/** Drag ids of a section's tiles: shortcuts carry their own id, the rest *are* ids. */
function tileIds(section: HomeSection): string[] {
    return section.kind === 'shortcut' ? section.items.map((s) => s.id) : [...section.items];
}

/** Which section holds a tile, and at which position. */
function locateTile(sections: HomeSection[], tileId: string): { section: HomeSection; index: number } | null {
    for (const section of sections) {
        const index = tileIds(section).indexOf(tileId);
        if (index >= 0) return { section, index };
    }
    return null;
}

/** The section a drag id points at — either a section itself, or a tile's owner. */
function resolveDropTarget(sections: HomeSection[], overId: string): { section: HomeSection; index: number } | null {
    const section = sections.find((s) => s.id === overId);
    // Dropped on the block itself (e.g. an empty section) → append at the end.
    if (section) return { section, index: section.items.length };
    return locateTile(sections, overId);
}

/** One tile's card visuals — shared by the grid and the drag overlay so the
 *  floating copy is pixel-identical to the card it left behind. */
function tileVisualFor(
    section: HomeSection,
    id: string,
    devices: Device[]
): { visual: TileVisual | null; compact: boolean } {
    if (section.kind === 'feature') {
        // Only features keep the full height; the rest use the shorter card.
        return { visual: featureTileVisual(id as HomeFeatureId), compact: false };
    }
    if (section.kind === 'device') {
        const device = devices.find((d) => d.id === id);
        return { visual: device ? deviceTileVisual(device, { editing: true }) : null, compact: true };
    }
    const item = section.items.find((s) => s.id === id);
    return { visual: item ? shortcutTileVisual(item, { editing: true }) : null, compact: true };
}

/** Wording of the "remove a populated section" confirmation. */
function removalWarning(section: HomeSection): string {
    const n = section.items.length;
    const tiles = `${n} tuile${n > 1 ? 's' : ''}`;
    const subject = section.title ? `« ${section.title} »` : 'Cette section';
    return `${subject} et ses ${tiles} seront retirées de l’accueil.`;
}

/** The card on its own, no drag wiring — rendered both in the grid and, while
 *  dragging, inside the DragOverlay, so the floating copy is identical. */
function TileCard({ visual, compact }: { visual: TileVisual | null; compact?: boolean }) {
    if (!visual) {
        return <div className={`${styles.missingTile} ${compact ? styles.missingCompact : ''}`}>Indisponible</div>;
    }
    return (
        <Widget
            widgetId={visual.widgetId}
            title={visual.title}
            icon={visual.icon}
            compact={compact}
            slim={visual.slim}
            interactive={false}
        >
            {visual.body}
        </Widget>
    );
}

/** One draggable tile inside a section grid. The whole card is the drag handle;
 *  the corner × removes it (no confirmation — re-adding is trivial). While it is
 *  being dragged the card itself rides in the overlay, so what stays here is just
 *  the hole it will drop into. */
function SortableTile({
    id,
    visual,
    compact,
    onEdit,
    onRemove
}: {
    id: string;
    visual: TileVisual | null;
    compact?: boolean;
    /** When set, shows a pencil button (e.g. to edit a shortcut). */
    onEdit?: () => void;
    onRemove: () => void;
}) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
    const style: React.CSSProperties = {
        transform: CSS.Translate.toString(transform),
        transition
    };
    return (
        <div
            ref={setNodeRef}
            style={style}
            className={`${styles.sortTile} ${isDragging ? styles.dragging : ''}`}
            {...attributes}
            {...listeners}
        >
            <TileCard visual={visual} compact={compact} />
            <div className={styles.tileActions}>
                {onEdit && (
                    <button
                        className={styles.tileAction}
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={onEdit}
                        title='Modifier'
                        aria-label='Modifier la tuile'
                    >
                        <span className={`icon icon-edit ${styles.actionIconEdit}`} />
                    </button>
                )}
                <button
                    className={`${styles.tileAction} ${styles.tileRemove}`}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={onRemove}
                    title='Retirer'
                    aria-label='Retirer la tuile'
                >
                    <span className={`icon icon-x ${styles.actionIconRemove}`} />
                </button>
            </div>
        </div>
    );
}

/** The sortable grid of one section's tiles + its trailing "add" button. Its
 *  SortableContext shares the page-level DndContext, so a tile can be dragged out
 *  into another section of the same kind (see EditableHome's drag handlers). */
function SectionTiles({
    section,
    devices,
    onAdd,
    onEditShortcut
}: {
    section: HomeSection;
    devices: Device[];
    onAdd: () => void;
    onEditShortcut: (item: ShortcutItem) => void;
}) {
    const addClass =
        section.kind === 'feature'
            ? styles.addFeature
            : section.kind === 'shortcut'
              ? styles.addShortcut
              : styles.addDevice;

    const ids = useMemo<string[]>(() => tileIds(section), [section]);

    const renderTile = (id: string) => {
        const { visual, compact } = tileVisualFor(section, id, devices);
        const onRemove = () => {
            if (section.kind === 'feature') removeFeature(section.id, id as HomeFeatureId);
            else if (section.kind === 'device') removeDevice(section.id, id);
            else removeShortcut(section.id, id);
        };
        const item = section.kind === 'shortcut' ? section.items.find((s) => s.id === id) : undefined;
        return (
            <SortableTile
                key={id}
                id={id}
                compact={compact}
                visual={visual}
                onEdit={item ? () => onEditShortcut(item) : undefined}
                onRemove={onRemove}
            />
        );
    };

    return (
        <SortableContext items={ids} strategy={sortInSection}>
            <div className={styles.tileGrid}>
                {ids.map(renderTile)}
                <button type='button' className={`${styles.addTile} ${addClass}`} onClick={onAdd}>
                    <span className={`icon icon-plus ${styles.addTileIcon}`} />
                    <span className={styles.addTileLabel}>{ADD_TILE_LABEL[section.kind]}</span>
                </button>
            </div>
        </SortableContext>
    );
}

/** A section block: a header (drag handle, optional title, kind, count, remove)
 *  + its tile grid. */
function SortableSection({
    section,
    devices,
    onAdd,
    onEditShortcut,
    onRemove
}: {
    section: HomeSection;
    devices: Device[];
    onAdd: () => void;
    onEditShortcut: (item: ShortcutItem) => void;
    onRemove: () => void;
}) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: section.id });
    const style: React.CSSProperties = {
        transform: CSS.Translate.toString(transform),
        transition,
        zIndex: isDragging ? 10 : undefined
    };

    return (
        <section
            ref={setNodeRef}
            style={style}
            className={`${styles.sectionBlock} ${isDragging ? styles.sectionDragging : ''}`}
        >
            <div className={styles.sectionHeader}>
                <button
                    className={styles.sectionHandle}
                    {...attributes}
                    {...listeners}
                    title='Glisser pour déplacer la section'
                    aria-label='Déplacer la section'
                >
                    <span className={`icon icon-drag ${styles.handleIcon}`} />
                </button>
                {/* The title is optional: left empty, the section renders with no
                    heading on the home. Committed on every keystroke — the server
                    sync is already debounced, so nothing can be lost on exit. */}
                <input
                    className={styles.sectionTitleInput}
                    value={section.title ?? ''}
                    onChange={(e) => renameSection(section.id, e.target.value)}
                    placeholder='Titre (facultatif)'
                    maxLength={40}
                    aria-label='Titre de la section'
                />
                {/*
                 * Deux réglages, et le second dépend du premier : « démarre
                 * repliée » n'apparaît que si la section peut l'être. Une
                 * section qu'on ne peut pas déplier mais qui démarre repliée
                 * serait simplement invisible, et le store retire d'ailleurs le
                 * second drapeau avec le premier.
                 */}
                <label className={styles.sectionToggle} title='La section peut être repliée sur l’accueil'>
                    <input
                        type='checkbox'
                        checked={section.collapsible === true}
                        onChange={(e) => setSectionCollapsible(section.id, e.target.checked)}
                    />
                    Repliable
                </label>
                {section.collapsible === true && (
                    <label className={styles.sectionToggle} title='Elle s’ouvre repliée'>
                        <input
                            type='checkbox'
                            checked={section.collapsed === true}
                            onChange={(e) => setSectionCollapsed(section.id, e.target.checked)}
                        />
                        Repliée au départ
                    </label>
                )}
                <span className={styles.sectionKind}>{SECTION_KIND_LABEL[section.kind]}</span>
                <span className={styles.sectionCount}>{section.items.length}</span>
                <button
                    className={`${styles.tileAction} ${styles.tileRemove} ${styles.sectionRemove}`}
                    onClick={onRemove}
                    title='Supprimer la section'
                    aria-label='Supprimer la section'
                >
                    <span className={`icon icon-x ${styles.actionIconRemove}`} />
                </button>
            </div>
            <SectionTiles section={section} devices={devices} onAdd={onAdd} onEditShortcut={onEditShortcut} />
        </section>
    );
}

export interface EditableHomeProps {
    /** Open the "add a section" dialog straight away (entered from an empty home). */
    autoOpenAdd?: boolean;
}

/**
 * Edit mode rendered straight onto the grid: the same tiles as the home, grouped
 * by section. A single DndContext drives both levels — sections reorder by their
 * header handle, tiles reorder inside their section *and* can be dragged into
 * another section of the same kind. A trailing "+" per section opens the matching
 * add dialog; a final "+" adds a whole section.
 */
export function EditableHome({ autoOpenAdd = false }: EditableHomeProps) {
    const layout = useHomeLayout();
    const { devices } = useDevices();
    const [addTarget, setAddTarget] = useState<string | null>(null);
    const [editShortcut, setEditShortcut] = useState<ShortcutEdit | null>(null);
    const [addingSection, setAddingSection] = useState(autoOpenAdd);
    const [confirmRemove, setConfirmRemove] = useState<HomeSection | null>(null);
    /** Tile currently riding in the drag overlay (null when dragging a section). */
    const [activeTileId, setActiveTileId] = useState<string | null>(null);
    /** Where that tile started, so a cancelled drag puts it back. */
    const dragOrigin = useRef<{ sectionId: string; index: number } | null>(null);

    // 8px activation distance: a plain click (e.g. the × button) never starts a
    // drag, and there's no stray text selection on press.
    const sensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
        useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
    );

    const sections = layout.sections;
    const ids = sections.map((s) => s.id);

    // A dialog target must follow the live layout (a removed section closes it).
    const addSectionTarget = sections.find((s) => s.id === addTarget) ?? null;
    const editTarget = editShortcut ? (sections.find((s) => s.id === editShortcut.sectionId) ?? null) : null;

    /**
     * Sections and tiles share one DndContext (that's what lets a tile cross into
     * another section), so targets must be filtered per drag:
     *  - dragging a section → only other sections are candidates;
     *  - dragging a tile → the section under the pointer wins first, then the
     *    closest tile inside it, so an empty section is still droppable and a
     *    tile can never land in a section the pointer isn't over.
     */
    const collisionDetection = useCallback<CollisionDetection>(
        (args) => {
            const sectionIds = new Set(sections.map((s) => s.id));
            const isSection = (id: string | number) => sectionIds.has(String(id));

            if (isSection(args.active.id)) {
                return closestCenter({
                    ...args,
                    droppableContainers: args.droppableContainers.filter((c) => isSection(c.id))
                });
            }

            // The keyboard sensor drags without a pointer, so `pointerWithin` would
            // find nothing: keep the plain in-section sorting it had before.
            if (!args.pointerCoordinates) {
                const own = sections.find((s) => tileIds(s).includes(String(args.active.id)));
                const ownTiles = new Set(own ? tileIds(own) : []);
                return closestCenter({
                    ...args,
                    droppableContainers: args.droppableContainers.filter((c) => ownTiles.has(String(c.id)))
                });
            }

            const hoveredSections = pointerWithin({
                ...args,
                droppableContainers: args.droppableContainers.filter((c) => isSection(c.id))
            });
            if (hoveredSections.length === 0) return [];

            const hovered = sections.find((s) => s.id === String(hoveredSections[0].id));
            const hoveredTileIds = new Set(hovered ? tileIds(hovered) : []);
            const tiles = closestCenter({
                ...args,
                droppableContainers: args.droppableContainers.filter((c) => hoveredTileIds.has(String(c.id)))
            });
            return tiles.length > 0 ? tiles : hoveredSections;
        },
        [sections]
    );

    /** The card the overlay carries — looked up live, since the tile changes
     *  section mid-drag. */
    const activeTile = useMemo(() => {
        if (!activeTileId) return null;
        const found = locateTile(sections, activeTileId);
        return found ? tileVisualFor(found.section, activeTileId, devices) : null;
    }, [activeTileId, sections, devices]);

    const onDragStart = (e: DragStartEvent) => {
        const id = String(e.active.id);
        // Sections drag as themselves (no overlay); only tiles get one.
        if (sections.some((s) => s.id === id)) return;
        const source = locateTile(sections, id);
        dragOrigin.current = source ? { sectionId: source.section.id, index: source.index } : null;
        setActiveTileId(id);
    };

    /**
     * A tile joins the hovered section as soon as it enters it, rather than on
     * drop. That's what makes the move feel like the in-section sort: the tile is
     * really part of the target grid, so its neighbours slide aside to open the
     * slot, and the section it left closes up behind it.
     */
    const onDragOver = (e: DragOverEvent) => {
        const { active, over } = e;
        if (!over || !activeTileId) return;
        const source = locateTile(sections, String(active.id));
        const target = resolveDropTarget(sections, String(over.id));
        if (!source || !target) return;
        if (target.section.id === source.section.id) return;
        // Kinds must match — transferSectionItem refuses anyway, but bailing here
        // keeps the tile visibly anchored in its own section.
        if (target.section.kind !== source.section.kind) return;
        transferSectionItem(source.section.id, target.section.id, source.index, target.index);
    };

    const onDragEnd = (e: DragEndEvent) => {
        setActiveTileId(null);
        dragOrigin.current = null;
        const { active, over } = e;
        if (!over) return;
        const activeId = String(active.id);
        const overId = String(over.id);

        // A section was dragged by its handle → reorder the blocks.
        if (sections.some((s) => s.id === activeId)) {
            if (activeId === overId) return;
            const from = ids.indexOf(activeId);
            const to = ids.indexOf(overId);
            if (from < 0 || to < 0) return;
            setSectionOrder(arrayMove(ids, from, to));
            return;
        }

        // The tile already sits in its target section (moved on hover); all that
        // is left is settling its position inside it.
        const source = locateTile(sections, activeId);
        const target = resolveDropTarget(sections, overId);
        if (!source || !target || target.section.id !== source.section.id) return;
        moveSectionItem(source.section.id, source.index, target.index);
    };

    /** Escape mid-drag: undo the hover-moves and put the tile back where it was. */
    const onDragCancel = () => {
        const origin = dragOrigin.current;
        const id = activeTileId;
        setActiveTileId(null);
        dragOrigin.current = null;
        if (!origin || !id) return;
        const current = locateTile(sections, id);
        if (!current || current.section.id === origin.sectionId) return;
        transferSectionItem(current.section.id, origin.sectionId, current.index, origin.index);
    };

    /** Empty sections go without asking; a populated one asks first (shortcuts
     *  carry real typing that can't be re-added in one click). */
    const requestRemove = (section: HomeSection) => {
        if (section.items.length === 0) removeSection(section.id);
        else setConfirmRemove(section);
    };

    const doRemove = () => {
        if (confirmRemove) removeSection(confirmRemove.id);
        setConfirmRemove(null);
    };

    return (
        <div className={styles.editRoot}>
            <DndContext
                sensors={sensors}
                collisionDetection={collisionDetection}
                // Tiles change section mid-drag, so the droppable rects must be
                // re-measured continuously or drops would land on stale positions.
                measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
                onDragStart={onDragStart}
                onDragOver={onDragOver}
                onDragCancel={onDragCancel}
                onDragEnd={onDragEnd}
            >
                <SortableContext items={ids} strategy={verticalListSortingStrategy}>
                    {sections.map((section) => (
                        <SortableSection
                            key={section.id}
                            section={section}
                            devices={devices}
                            onAdd={() => setAddTarget(section.id)}
                            onEditShortcut={(item) => setEditShortcut({ sectionId: section.id, item })}
                            onRemove={() => requestRemove(section)}
                        />
                    ))}
                </SortableContext>

                <DragOverlay dropAnimation={{ duration: 200, easing: 'cubic-bezier(0.18, 0.67, 0.6, 1.22)' }}>
                    {activeTile ? (
                        <div className={styles.overlayTile}>
                            <TileCard visual={activeTile.visual} compact={activeTile.compact} />
                        </div>
                    ) : null}
                </DragOverlay>
            </DndContext>

            <button type='button' className={styles.addSection} onClick={() => setAddingSection(true)}>
                <span className={`icon icon-plus ${styles.addTileIcon}`} />
                <span className={styles.addTileLabel}>Ajouter une section</span>
            </button>

            <AddSectionDialog open={addingSection} onClose={() => setAddingSection(false)} />

            <AddTileDialog
                section={editShortcut ? editTarget : addSectionTarget}
                editShortcut={editShortcut?.item ?? null}
                onClose={() => {
                    setAddTarget(null);
                    setEditShortcut(null);
                }}
            />

            <Dialog
                open={confirmRemove !== null}
                onClose={() => setConfirmRemove(null)}
                title='Supprimer la section ?'
                onSubmit={doRemove}
                footer={
                    <>
                        <Button variant='secondary' onClick={() => setConfirmRemove(null)}>
                            Annuler
                        </Button>
                        <Button variant='danger' onClick={doRemove}>
                            Supprimer
                        </Button>
                    </>
                }
            >
                <p className={styles.confirmText}>{confirmRemove ? removalWarning(confirmRemove) : ''}</p>
            </Dialog>
        </div>
    );
}

export default EditableHome;
