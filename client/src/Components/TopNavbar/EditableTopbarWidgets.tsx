import { useState } from 'react';
import {
    DndContext,
    closestCenter,
    KeyboardSensor,
    PointerSensor,
    useSensor,
    useSensors,
    type DragEndEvent
} from '@dnd-kit/core';
import {
    arrayMove,
    SortableContext,
    sortableKeyboardCoordinates,
    useSortable,
    horizontalListSortingStrategy
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { HomeTopbarWidgetId } from 'deveye-types';

import { Dialog } from '@/Components/Dialog';
import { addTopbarWidget, removeTopbarWidget, setTopbarOrder, useHomeLayout } from '@/stores/homeLayout';
import { useActiveWorkspace } from '@/stores/workspace';
import { availableTopbarWidgets, renderTopbarWidget, usableTopbarWidgetIds } from './topbarWidgets';
import styles from './EditableTopbarWidgets.module.css';

/** One draggable widget chip: the live widget (non-interactive) + a remove ×. */
function SortableChip({ id }: { id: HomeTopbarWidgetId }) {
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
            className={`${styles.chip} ${isDragging ? styles.dragging : ''}`}
            {...attributes}
            {...listeners}
            title='Glisser pour réordonner'
        >
            {/* Live preview, but inert: the drag/remove own the interactions. */}
            <span className={styles.preview}>{renderTopbarWidget(id)}</span>
            <button
                className={styles.remove}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => removeTopbarWidget(id)}
                title='Retirer'
                aria-label='Retirer le widget'
            >
                <span className='icon icon-x' />
            </button>
        </div>
    );
}

/** Picker dialog listing widgets not yet pinned. */
function AddDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
    const layout = useHomeLayout();
    const workspace = useActiveWorkspace();
    const used = new Set(layout.topbar);
    const available = availableTopbarWidgets(workspace?.kind).filter((w) => !used.has(w.id));
    return (
        <Dialog open={open} onClose={onClose} title='Ajouter un widget' width={460}>
            {available.length === 0 ? (
                <p className={styles.empty}>Tous les widgets sont déjà affichés.</p>
            ) : (
                <div className={styles.addList}>
                    {available.map((w) => (
                        <button
                            key={w.id}
                            className={styles.addItem}
                            onClick={() => {
                                addTopbarWidget(w.id);
                                onClose();
                            }}
                        >
                            <span className={`icon icon-${w.icon} ${styles.addItemIcon}`} />
                            <span className={styles.addItemLabel}>
                                {w.title}
                                <span className={styles.addItemSub}>{w.description}</span>
                            </span>
                            <span className={`icon icon-plus ${styles.addItemPlus}`} />
                        </button>
                    ))}
                </div>
            )}
        </Dialog>
    );
}

/**
 * In-place editor for the navbar mini-widgets, shown while organizing the home.
 * It replaces the live widgets exactly where they sit, so the topbar is arranged
 * right there (no detour through the grid): chips are drag-reorderable, each
 * carries a remove ×, and a trailing + opens the add picker. Always visible in
 * edit mode — even with no widgets — so the first one can be added.
 */
export function EditableTopbarWidgets() {
    const layout = useHomeLayout();
    const workspace = useActiveWorkspace();
    const items = usableTopbarWidgetIds(layout.topbar, workspace?.kind);
    const [addOpen, setAddOpen] = useState(false);

    const sensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
        useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
    );

    const onDragEnd = (e: DragEndEvent) => {
        const { active, over } = e;
        if (!over || active.id === over.id) return;
        const from = items.indexOf(active.id as HomeTopbarWidgetId);
        const to = items.indexOf(over.id as HomeTopbarWidgetId);
        if (from < 0 || to < 0) return;
        setTopbarOrder(arrayMove(items, from, to));
    };

    // « Tout est affiché » se mesure sur ce que CET espace propose : dans un
    // espace personnel, « Présence » ne compte pas comme un widget manquant.
    const full = items.length >= availableTopbarWidgets(workspace?.kind).length;

    return (
        <div className={styles.editor} title='Barre supérieure — glissez, retirez ou ajoutez'>
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
                <SortableContext items={items} strategy={horizontalListSortingStrategy}>
                    {items.map((id) => (
                        <SortableChip key={id} id={id} />
                    ))}
                </SortableContext>
            </DndContext>
            {!full && (
                <button
                    type='button'
                    className={styles.add}
                    onClick={() => setAddOpen(true)}
                    title='Ajouter un widget'
                    aria-label='Ajouter un widget à la barre'
                >
                    <span className='icon icon-plus' />
                </button>
            )}
            <AddDialog open={addOpen} onClose={() => setAddOpen(false)} />
        </div>
    );
}

export default EditableTopbarWidgets;
