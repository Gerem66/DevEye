import { useEffect, useRef } from 'react';

/**
 * Global LIFO stack of dismissible overlays — every Dialog/Popup, the feature
 * panel (WidgetPopup) and the settings panel register here while open. A single
 * window keydown listener routes Escape to the *topmost* layer only, so nested
 * overlays close one at a time in tree order — the innermost (most recently
 * opened) first — instead of every layer reacting to the same keystroke.
 *
 * A layer registered with a `null` handler *absorbs* Escape (does nothing) so it
 * never leaks to a layer underneath — used by non-dismissible dialogs.
 */
type Layer = { onEscape: (() => void) | null };

const stack: Layer[] = [];
let listening = false;

function handleKey(e: KeyboardEvent): void {
    if (e.key !== 'Escape') return;
    const top = stack[stack.length - 1];
    if (!top) return;
    top.onEscape?.();
}

function ensureListener(): void {
    if (listening) return;
    window.addEventListener('keydown', handleKey);
    listening = true;
}

/**
 * Push a dismissible layer onto the stack; returns its unregister function. Call
 * on open, unregister on close (see {@link useDismissLayer}).
 */
export function pushDismissLayer(onEscape: (() => void) | null): () => void {
    const layer: Layer = { onEscape };
    stack.push(layer);
    ensureListener();
    return () => {
        const i = stack.lastIndexOf(layer);
        if (i !== -1) stack.splice(i, 1);
    };
}

/**
 * Register `onEscape` as the topmost dismissible layer while `open` is true, so
 * Escape closes overlays in tree order (innermost first). Pass `null` to absorb
 * Escape without closing (non-dismissible dialogs). The handler is read through a
 * ref, so passing an inline closure never re-registers the layer.
 */
export function useDismissLayer(open: boolean, onEscape: (() => void) | null): void {
    const ref = useRef(onEscape);
    ref.current = onEscape;
    // Re-register only when opening/closing or when toggling absorb⇄handle.
    const absorbs = onEscape === null;
    useEffect(() => {
        if (!open) return;
        return pushDismissLayer(absorbs ? null : () => ref.current?.());
    }, [open, absorbs]);
}
