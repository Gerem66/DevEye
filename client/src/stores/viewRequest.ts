/**
 * Cross-feature view navigation: a feature rendered inside the home popup can
 * ask the home page to open another view (e.g. Monitoring's "Gérer les
 * appareils" entry opening the Appareils page). The home page registers the
 * single handler; requests made while none is registered are dropped (there is
 * nowhere to navigate to).
 */

type OpenViewHandler = (viewId: string) => void;

let handler: OpenViewHandler | null = null;

/** Register the navigation handler (the home page). Returns the unregister. */
export function onOpenViewRequest(fn: OpenViewHandler): () => void {
    handler = fn;
    return () => {
        if (handler === fn) handler = null;
    };
}

/** Ask the home page to open a view by its id (e.g. `clients`, `profile`). */
export function requestOpenView(viewId: string): void {
    handler?.(viewId);
}
