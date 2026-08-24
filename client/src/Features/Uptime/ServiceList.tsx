import { useRef } from 'react';

import { useDragReorder } from '@/dragReorder';

import ServiceCard from './ServiceCard';
import styles from './style.module.css';

import type { UptimeService } from '@deveye/types';

interface ServiceListProps {
    /** The workspace's services, already in the user's order. */
    services: UptimeService[];
    onOpen: (service: UptimeService) => void;
    onEdit: (service: UptimeService) => void;
    /** The complete new order after a drop. */
    onReorder: (ids: number[]) => void;
    /** A drag started or ended — the host pauses its polling meanwhile. */
    onDragStateChange: (dragging: boolean) => void;
}

/**
 * The service list, with drag & drop ordering.
 *
 * The gesture itself lives in {@link ../../dragReorder}: it is shared with Git,
 * Monitoring and the databases, and the reasons it is written on pointer events
 * rather than the HTML5 `draggable` API are documented there. What stays here is
 * only what makes this list look like itself — the card, its grip, and the
 * insertion bar.
 */
export function ServiceList({ services, onOpen, onEdit, onReorder, onDragStateChange }: ServiceListProps) {
    /** A real drag just ended: the click the browser still fires afterwards
     *  must not also open the detail view. Unlike the other lists, the grip
     *  sits *inside* the clickable card, so the click does reach it. */
    const suppressClickRef = useRef(false);

    const drag = useDragReorder<HTMLDivElement, HTMLSpanElement>({
        ids: services.map((s) => s.id),
        rowSelector: '[data-service-card]',
        onReorder: (ids) => onReorder(ids as number[]),
        onDragStateChange: (dragging) => {
            // On the falling edge only, and only after a real drag: that is
            // exactly when the browser is about to fire the stray click.
            if (!dragging) suppressClickRef.current = true;
            onDragStateChange(dragging);
        }
    });

    return (
        <div ref={drag.listRef} className={styles.list}>
            {services.map((service) => (
                <ServiceCard
                    key={service.id}
                    service={service}
                    dragging={drag.draggingId === service.id}
                    onOpen={() => {
                        if (suppressClickRef.current) {
                            suppressClickRef.current = false;
                            return;
                        }
                        onOpen(service);
                    }}
                    onEdit={() => onEdit(service)}
                    onDragPointerDown={(e) => drag.onGripPointerDown(e, service.id)}
                />
            ))}
            <span ref={drag.barRef} className={styles.dropBar} aria-hidden='true' />
        </div>
    );
}

export default ServiceList;
