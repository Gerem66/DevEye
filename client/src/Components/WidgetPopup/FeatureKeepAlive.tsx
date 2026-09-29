import { type ReactNode, useRef, useState, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';

import ErrorBoundary from '@/Components/ErrorBoundary';

export interface FeatureKeepAliveProps {
    /**
     * Where the feature should be displayed. When set (the open popup body) the
     * content's DOM is moved there; when null it is moved back into a hidden
     * holder so the component — and all its state — stays mounted while closed.
     */
    target: HTMLElement | null;
    /** Le module derrière la vue, pour mener à sa page d'état si elle plante. */
    featureId?: string | null;
    children: ReactNode;
}

/**
 * Keeps a feature mounted across open/close: the children are portaled into a
 * single persistent container (a portal remounts its children if its container
 * changes), and that container's DOM node is moved with `appendChild` between
 * the open popup body and a hidden holder. State is fully preserved; the
 * component only unmounts when the dashboard stops rendering it.
 */
export default function FeatureKeepAlive({ target, featureId, children }: FeatureKeepAliveProps) {
    // Persistent portal container. `display: contents` keeps it layout-neutral
    // so the feature behaves as a direct child of whatever hosts it.
    const [container] = useState<HTMLDivElement>(() => {
        const el = document.createElement('div');
        el.style.display = 'contents';
        return el;
    });

    const hiddenHolderRef = useRef<HTMLDivElement>(null);

    // Move the (stable) container into the active target or the hidden holder.
    useLayoutEffect(() => {
        const dest = target ?? hiddenHolderRef.current;
        if (dest && container.parentNode !== dest) {
            dest.appendChild(container);
        }
    }, [target, container]);

    // Detach the container from the DOM when this feature is unmounted.
    useLayoutEffect(() => {
        return () => container.remove();
    }, [container]);

    return (
        <>
            <div ref={hiddenHolderRef} style={{ display: 'none' }} />
            {/* Une fonctionnalité qui plante ne blanchit qu'elle-même : la
                frontière suit l'arbre React, pas le DOM où le portail l'emmène. */}
            {createPortal(
                <ErrorBoundary variant='view' canReport featureId={featureId}>
                    {children}
                </ErrorBoundary>,
                container
            )}
        </>
    );
}
