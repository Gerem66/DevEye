import { useCallback, useEffect, useRef } from 'react';

import ServiceCard from './ServiceCard';
import styles from './style.module.css';

import type { UptimeService } from 'deveye-types';

interface ServiceListProps {
    /** The workspace's services, already in the user's order. */
    services: UptimeService[];
    /** Ids with an action in flight (their buttons are disabled). */
    busy: ReadonlySet<number>;
    onOpen: (service: UptimeService) => void;
    onEdit: (service: UptimeService) => void;
    onToggle: (service: UptimeService) => void;
    onCheckNow: (service: UptimeService) => void;
    /** The complete new order after a drop. */
    onReorder: (ids: number[]) => void;
    /** A drag started or ended — the host pauses its polling meanwhile. */
    onDragStateChange: (dragging: boolean) => void;
}

/** Half the list's row gap, where the insertion bar is centred. */
function halfGap(list: HTMLElement): number {
    return (parseFloat(getComputedStyle(list).rowGap) || 0) / 2;
}

/** The order `ids` become when `draggedId` lands in gap `gap`, or null if unchanged. */
function reordered(services: UptimeService[], draggedId: number, gap: number): number[] | null {
    const from = services.findIndex((s) => s.id === draggedId);
    if (from === -1) return null;
    const rest = services.filter((s) => s.id !== draggedId);
    // Removing the dragged row first shifts every gap after it by one.
    rest.splice(from < gap ? gap - 1 : gap, 0, services[from]);
    const ids = rest.map((s) => s.id);
    return ids.every((id, i) => id === services[i].id) ? null : ids;
}

/**
 * The service list, with drag & drop ordering.
 *
 * The whole list is the drop target (events bubble up from the cards), and the
 * landing spot is shown as a bar standing in the gap the row would fall into —
 * the rows themselves are never restyled or displaced, so what you see is
 * exactly where it lands.
 *
 * **The bar is driven straight through the DOM, never React state.** `dragover`
 * fires continuously while the pointer moves; re-rendering the rows under it
 * makes the browser re-fire drag events on the replaced nodes, which feeds back
 * into another render and locks the tab up (the bug this pattern was written
 * for, in {@link ../Notes/NoteGrid}). Refs keep the drag render-free.
 */
export function ServiceList({
    services,
    busy,
    onOpen,
    onEdit,
    onToggle,
    onCheckNow,
    onReorder,
    onDragStateChange
}: ServiceListProps) {
    const listRef = useRef<HTMLDivElement>(null);
    const barRef = useRef<HTMLSpanElement>(null);
    /** Gap the bar currently marks, or null while it is hidden. */
    const gapRef = useRef<number | null>(null);
    /** The service being dragged; a ref so starting a drag renders nothing. */
    const draggedRef = useRef<number | null>(null);

    /** The rendered service rows, in order. */
    const rowEls = useCallback(
        () => Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-service-card]') ?? []),
        []
    );

    const hideBar = useCallback(() => {
        gapRef.current = null;
        if (barRef.current) barRef.current.style.opacity = '0';
    }, []);

    /** Stand the bar in gap `index` (0 = above the first row). */
    const showBar = useCallback(
        (index: number) => {
            const list = listRef.current;
            const bar = barRef.current;
            if (!list || !bar || gapRef.current === index) return;
            const rows = rowEls();
            if (rows.length === 0) return;

            // The gap's true middle, taken from the rows that border it — so the
            // bar is centred by construction rather than by a corrective offset.
            const boxes = rows.map((el) => el.getBoundingClientRect());
            let centre: number;
            if (index <= 0) centre = boxes[0].top - halfGap(list);
            else if (index >= boxes.length) centre = boxes[boxes.length - 1].bottom + halfGap(list);
            else centre = (boxes[index - 1].bottom + boxes[index].top) / 2;

            gapRef.current = index;
            const listBox = list.getBoundingClientRect();
            // Less half the bar's own height, read from the DOM so its thickness
            // stays defined only in the CSS.
            bar.style.transform = `translateY(${centre - listBox.top - bar.offsetHeight / 2}px)`;
            bar.style.opacity = '1';
        },
        [rowEls]
    );

    /** Gap nearest the pointer: every row's top and bottom edge is a candidate. */
    const gapAt = useCallback(
        (clientY: number): number => {
            let best = 0;
            let bestDistance = Infinity;
            for (const [i, el] of rowEls().entries()) {
                const box = el.getBoundingClientRect();
                for (const [y, gap] of [
                    [box.top, i],
                    [box.bottom, i + 1]
                ]) {
                    const distance = Math.abs(clientY - y);
                    if (distance < bestDistance) {
                        bestDistance = distance;
                        best = gap;
                    }
                }
            }
            return best;
        },
        [rowEls]
    );

    const endDrag = useCallback(() => {
        hideBar();
        if (draggedRef.current !== null) {
            draggedRef.current = null;
            onDragStateChange(false);
        }
    }, [hideBar, onDragStateChange]);

    // A drop outside the list (or nowhere) never reaches its handlers, so the
    // bar is also cleared whenever any drag ends.
    useEffect(() => {
        document.addEventListener('dragend', endDrag);
        return () => document.removeEventListener('dragend', endDrag);
    }, [endDrag]);

    function handleDragOver(e: React.DragEvent) {
        if (draggedRef.current === null) return;
        e.preventDefault(); // required for the drop to be allowed at all
        e.dataTransfer.dropEffect = 'move';
        showBar(gapAt(e.clientY));
    }

    function handleDrop(e: React.DragEvent) {
        e.preventDefault();
        const gap = gapRef.current;
        const dragged = draggedRef.current;
        endDrag();
        if (gap === null || dragged === null) return;
        const ids = reordered(services, dragged, gap);
        if (ids) onReorder(ids);
    }

    function handleDragLeave(e: React.DragEvent) {
        // Moving between rows fires dragleave too; only a real exit hides the bar.
        if (!listRef.current?.contains(e.relatedTarget as Node | null)) hideBar();
    }

    return (
        <div
            ref={listRef}
            className={styles.list}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            onDragLeave={handleDragLeave}
        >
            {services.map((service) => (
                <ServiceCard
                    key={service.id}
                    service={service}
                    busy={busy.has(service.id)}
                    onOpen={() => onOpen(service)}
                    onEdit={() => onEdit(service)}
                    onToggle={() => onToggle(service)}
                    onCheckNow={() => onCheckNow(service)}
                    onDragStart={() => {
                        draggedRef.current = service.id;
                        onDragStateChange(true);
                    }}
                    onDragEnd={endDrag}
                />
            ))}
            <span ref={barRef} className={styles.dropBar} aria-hidden='true' />
        </div>
    );
}

export default ServiceList;
