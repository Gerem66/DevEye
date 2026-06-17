import { type ReactNode, useRef, useState, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';

export interface FeatureKeepAliveProps {
    /**
     * Where the feature should be displayed. When set (the open popup body) the
     * content's DOM is moved there; when null it is moved back into a hidden
     * holder so the component — and all its state — stays mounted while closed.
     */
    target: HTMLElement | null;
    children: ReactNode;
}

/**
 * Keeps a feature mounted across open/close without ever remounting it.
 *
 * The trick: the children are portaled into a *single persistent container*
 * whose identity never changes, so React never tears the subtree down (a portal
 * remounts its children if you change its container — which would reload the
 * feature). Instead we physically move that container's DOM node between the
 * open popup body and a hidden holder with `appendChild`. React doesn't care
 * where the container lives in the document, so feature state (fetched data,
 * scroll, form input…) is fully preserved.
 *
 * The component only truly unmounts — firing its `useFeatureLifecycle`
 * onUnmount — when the dashboard stops rendering it (TTL expiry, forced reset).
 */
export default function FeatureKeepAlive({ target, children }: FeatureKeepAliveProps) {
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
            {createPortal(children, container)}
        </>
    );
}
