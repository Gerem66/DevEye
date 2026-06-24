import { useMemo, useState } from 'react';
import {
    DndContext,
    closestCenter,
    KeyboardSensor,
    PointerSensor,
    useSensor,
    useSensors,
    type DragEndEvent,
    type SensorDescriptor
} from '@dnd-kit/core';
import {
    arrayMove,
    SortableContext,
    sortableKeyboardCoordinates,
    useSortable,
    rectSortingStrategy,
    verticalListSortingStrategy
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Device, HomeCategory, HomeCategoryKind, HomeFeatureId, ShortcutItem } from 'deveye-types';

import { useDevices } from '@/stores/devices';
import {
    removeDevice,
    removeFeature,
    removeShortcut,
    setCategoryOrder,
    setDeviceOrder,
    setFeatureOrder,
    setShortcutOrder,
    useHomeLayout
} from '@/stores/homeLayout';
import { Widget } from '@/Components/Widget';
import { deviceTileVisual, featureTileVisual, shortcutTileVisual, type TileVisual } from '../tiles/tileVisual';
import { AddTileDialog } from './AddTileDialog';
import styles from './organize.module.css';

const CATEGORY_TITLE: Record<HomeCategoryKind, string> = {
    device: 'Appareils',
    feature: 'Fonctionnalités',
    shortcut: 'Raccourcis'
};

const ADD_LABEL: Record<HomeCategoryKind, string> = {
    device: 'Ajouter un appareil',
    feature: 'Ajouter une fonctionnalité',
    shortcut: 'Créer un raccourci'
};

/** One draggable tile inside a category grid. The whole card is the drag handle;
 *  the corner × removes it (no confirmation — re-adding is trivial). */
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
        transition,
        zIndex: isDragging ? 5 : undefined
    };
    return (
        <div
            ref={setNodeRef}
            style={style}
            className={`${styles.sortTile} ${isDragging ? styles.dragging : ''}`}
            {...attributes}
            {...listeners}
        >
            {visual ? (
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
            ) : (
                <div className={`${styles.missingTile} ${compact ? styles.missingCompact : ''}`}>Indisponible</div>
            )}
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

/** The sortable grid of one category's tiles + its trailing "add" button. The
 *  inner DndContext isolates reordering to this category (tiles can't leave it). */
function CategoryTiles({
    category,
    devices,
    sensors,
    onAdd,
    onEditShortcut
}: {
    category: HomeCategory;
    devices: Device[];
    sensors: SensorDescriptor<object>[];
    onAdd: () => void;
    onEditShortcut: (item: ShortcutItem) => void;
}) {
    // Devices and shortcuts use the shorter card; features keep the full height.
    const compact = category.kind !== 'feature';
    const addClass =
        category.kind === 'feature'
            ? styles.addFeature
            : category.kind === 'device'
              ? styles.addDevice
              : styles.addShortcut;

    const ids = useMemo<string[]>(() => {
        if (category.kind === 'shortcut') return category.items.map((s) => s.id);
        return [...category.items];
    }, [category]);

    const onDragEnd = (e: DragEndEvent) => {
        const { active, over } = e;
        if (!over || active.id === over.id) return;
        const from = ids.indexOf(String(active.id));
        const to = ids.indexOf(String(over.id));
        if (from < 0 || to < 0) return;
        if (category.kind === 'feature') setFeatureOrder(arrayMove(category.items, from, to));
        else if (category.kind === 'device') setDeviceOrder(arrayMove(category.items, from, to));
        else setShortcutOrder(arrayMove(category.items, from, to));
    };

    const renderTile = (id: string) => {
        if (category.kind === 'feature') {
            return (
                <SortableTile
                    key={id}
                    id={id}
                    compact={compact}
                    visual={featureTileVisual(id as HomeFeatureId)}
                    onRemove={() => removeFeature(id as HomeFeatureId)}
                />
            );
        }
        if (category.kind === 'device') {
            const device = devices.find((d) => d.id === id);
            return (
                <SortableTile
                    key={id}
                    id={id}
                    compact={compact}
                    visual={device ? deviceTileVisual(device, { editing: true }) : null}
                    onRemove={() => removeDevice(id)}
                />
            );
        }
        const item = category.items.find((s) => s.id === id);
        return (
            <SortableTile
                key={id}
                id={id}
                compact={compact}
                visual={item ? shortcutTileVisual(item, { editing: true }) : null}
                onEdit={item ? () => onEditShortcut(item) : undefined}
                onRemove={() => removeShortcut(id)}
            />
        );
    };

    return (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={ids} strategy={rectSortingStrategy}>
                <div className={styles.tileGrid}>
                    {ids.map(renderTile)}
                    <button type='button' className={`${styles.addTile} ${addClass}`} onClick={onAdd}>
                        <span className={`icon icon-plus ${styles.addTileIcon}`} />
                        <span className={styles.addTileLabel}>{ADD_LABEL[category.kind]}</span>
                    </button>
                </div>
            </SortableContext>
        </DndContext>
    );
}

/** A category block: a drag-handle header (reorders categories) + its tile grid. */
function SortableCategory({
    category,
    devices,
    sensors,
    onAdd,
    onEditShortcut
}: {
    category: HomeCategory;
    devices: Device[];
    sensors: SensorDescriptor<object>[];
    onAdd: () => void;
    onEditShortcut: (item: ShortcutItem) => void;
}) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: category.kind });
    const style: React.CSSProperties = {
        transform: CSS.Translate.toString(transform),
        transition,
        zIndex: isDragging ? 10 : undefined
    };
    const count = category.items.length;

    return (
        <section
            ref={setNodeRef}
            style={style}
            className={`${styles.catBlock} ${isDragging ? styles.catDragging : ''}`}
        >
            <div className={styles.catHeader}>
                <button
                    className={styles.catHandle}
                    {...attributes}
                    {...listeners}
                    title='Glisser pour déplacer la catégorie'
                    aria-label='Déplacer la catégorie'
                >
                    <span className={`icon icon-drag ${styles.handleIcon}`} />
                </button>
                <h3 className={styles.catTitle}>{CATEGORY_TITLE[category.kind]}</h3>
                <span className={styles.catCount}>{count}</span>
            </div>
            <CategoryTiles
                category={category}
                devices={devices}
                sensors={sensors}
                onAdd={onAdd}
                onEditShortcut={onEditShortcut}
            />
        </section>
    );
}

/**
 * Edit mode rendered straight onto the grid: the same tiles as the home, grouped
 * by category. Categories are drag-reorderable (header handle); tiles are
 * drag-sortable within their own category (each category has an isolated
 * DndContext so tiles can't cross categories). A trailing "+" per category opens
 * the matching add dialog.
 */
export function EditableHome() {
    const layout = useHomeLayout();
    const { devices } = useDevices();
    const [addKind, setAddKind] = useState<HomeCategoryKind | null>(null);
    const [editShortcut, setEditShortcut] = useState<ShortcutItem | null>(null);

    // 8px activation distance: a plain click (e.g. the × button) never starts a
    // drag, and there's no stray text selection on press.
    const sensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
        useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
    );

    const kinds = layout.categories.map((c) => c.kind);

    const onCategoryDragEnd = (e: DragEndEvent) => {
        const { active, over } = e;
        if (!over || active.id === over.id) return;
        const from = kinds.indexOf(active.id as HomeCategoryKind);
        const to = kinds.indexOf(over.id as HomeCategoryKind);
        if (from < 0 || to < 0) return;
        setCategoryOrder(arrayMove(kinds, from, to));
    };

    return (
        <div className={styles.editRoot}>
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onCategoryDragEnd}>
                <SortableContext items={kinds} strategy={verticalListSortingStrategy}>
                    {layout.categories.map((category) => (
                        <SortableCategory
                            key={category.kind}
                            category={category}
                            devices={devices}
                            sensors={sensors}
                            onAdd={() => setAddKind(category.kind)}
                            onEditShortcut={setEditShortcut}
                        />
                    ))}
                </SortableContext>
            </DndContext>

            <AddTileDialog
                kind={addKind}
                editShortcut={editShortcut}
                onClose={() => {
                    setAddKind(null);
                    setEditShortcut(null);
                }}
            />
        </div>
    );
}

export default EditableHome;
