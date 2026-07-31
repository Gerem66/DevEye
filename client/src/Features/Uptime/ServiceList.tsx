import { useCallback, useEffect, useRef, useState } from 'react';

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

/** Pointer movement, in px, before a press commits to a drag rather than a click. */
const DRAG_THRESHOLD = 6;

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
 * The whole list is the drop target, and the landing spot is shown as a bar
 * standing in the gap the row would fall into — the rows themselves are never
 * restyled or displaced, so what you see is exactly where it lands.
 *
 * **Driven by Pointer Events, not HTML5 `draggable`.** {@link ../Notes/NoteGrid}
 * uses the native `draggable` API; this list deliberately doesn't, because that
 * API hands control of the gesture to the browser's own drag session — and on
 * this platform (Chromium on Linux) an interrupted native session can leave the
 * whole page believing a drag is still in progress: the pointer stays a grab
 * cursor and nothing responds to clicks, not even the browser's own context
 * menu, until something outside the page (Escape, alt-tab) breaks it. That is
 * a platform failure mode, not a bug reachable from application code, so it
 * can't be fixed by being more careful with `dragend` — only by never handing
 * the gesture to the browser at all. A hand-rolled pointer-capture drag keeps
 * 100% of the state in this component's own refs (see below, same render-free
 * discipline as NoteGrid), never touches the browser's DnD state machine, and
 * gets touch support as a side effect.
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
    /** Id + pointer id of the press being tracked, before the threshold is crossed. */
    const pressRef = useRef<{ id: number; pointerId: number; x: number; y: number } | null>(null);
    /** Id actually being dragged (threshold crossed), or null. Logic reads this. */
    const draggedRef = useRef<number | null>(null);
    /** Same id, mirrored into state only to dim the dragged card — set at most
     *  twice per drag (start/end), never on every pointer move. */
    const [draggedId, setDraggedId] = useState<number | null>(null);
    /** A real drag just ended: the click the browser still fires afterwards
     *  must not also open the detail view. */
    const suppressClickRef = useRef(false);

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

    // Refs so the global listeners below can always call the latest handlers
    // without re-subscribing on every render (they're only (un)installed once,
    // per drag, from handlePointerDown/endDrag — see effect further down).
    const showBarRef = useRef(showBar);
    showBarRef.current = showBar;
    const gapAtRef = useRef(gapAt);
    gapAtRef.current = gapAt;
    const servicesRef = useRef(services);
    servicesRef.current = services;
    const onReorderRef = useRef(onReorder);
    onReorderRef.current = onReorder;

    const endDrag = useCallback(() => {
        window.removeEventListener('pointermove', handleWindowPointerMove);
        window.removeEventListener('pointerup', handleWindowPointerUp);
        window.removeEventListener('pointercancel', handleWindowPointerCancel);
        window.removeEventListener('blur', handleWindowBlur);
        window.removeEventListener('keydown', handleWindowKeyDown);
        hideBar();
        document.body.style.removeProperty('cursor');
        document.body.style.removeProperty('user-select');
        pressRef.current = null;
        if (draggedRef.current !== null) {
            draggedRef.current = null;
            setDraggedId(null);
            onDragStateChange(false);
        }
    }, [hideBar, onDragStateChange]);

    function handleWindowPointerMove(e: PointerEvent) {
        const press = pressRef.current;
        if (!press || e.pointerId !== press.pointerId) return;

        if (draggedRef.current === null) {
            // Below threshold: this may still turn out to be a plain click.
            if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < DRAG_THRESHOLD) return;
            draggedRef.current = press.id;
            setDraggedId(press.id);
            onDragStateChange(true);
            document.body.style.cursor = 'grabbing';
            document.body.style.userSelect = 'none';
        }
        showBarRef.current(gapAtRef.current(e.clientY));
    }

    function handleWindowPointerUp(e: PointerEvent) {
        const press = pressRef.current;
        if (!press || e.pointerId !== press.pointerId) return;
        const dragged = draggedRef.current;
        const gap = gapRef.current;
        if (dragged !== null) suppressClickRef.current = true;
        endDrag();
        if (dragged !== null && gap !== null) {
            const ids = reordered(servicesRef.current, dragged, gap);
            if (ids) onReorderRef.current(ids);
        }
    }

    function handleWindowPointerCancel(e: PointerEvent) {
        if (pressRef.current?.pointerId !== e.pointerId) return;
        endDrag();
    }

    function handleWindowBlur() {
        // A drag left mid-gesture (alt-tab, a native dialog) must not linger.
        endDrag();
    }

    function handleWindowKeyDown(e: KeyboardEvent) {
        if (e.key === 'Escape') endDrag();
    }

    // Belt-and-braces: release everything if the component itself goes away
    // mid-drag (e.g. the feature popup closes).
    useEffect(() => endDrag, [endDrag]);

    function handlePointerDown(e: React.PointerEvent, serviceId: number) {
        // Primary button/contact only; the action buttons stop their own clicks
        // from reaching here, but a stray pointerdown on one must not start a
        // drag either.
        if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
        pressRef.current = { id: serviceId, pointerId: e.pointerId, x: e.clientX, y: e.clientY };
        window.addEventListener('pointermove', handleWindowPointerMove);
        window.addEventListener('pointerup', handleWindowPointerUp);
        window.addEventListener('pointercancel', handleWindowPointerCancel);
        window.addEventListener('blur', handleWindowBlur);
        window.addEventListener('keydown', handleWindowKeyDown);
    }

    return (
        <div ref={listRef} className={styles.list}>
            {services.map((service) => (
                <ServiceCard
                    key={service.id}
                    service={service}
                    busy={busy.has(service.id)}
                    dragging={draggedId === service.id}
                    onOpen={() => {
                        if (suppressClickRef.current) {
                            suppressClickRef.current = false;
                            return;
                        }
                        onOpen(service);
                    }}
                    onEdit={() => onEdit(service)}
                    onToggle={() => onToggle(service)}
                    onCheckNow={() => onCheckNow(service)}
                    onDragPointerDown={(e) => handlePointerDown(e, service.id)}
                />
            ))}
            <span ref={barRef} className={styles.dropBar} aria-hidden='true' />
        </div>
    );
}

export default ServiceList;
