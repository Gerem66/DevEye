/**
 * Cross-feature view navigation: a view rendered inside the home popup can ask
 * the home page to open another one. The home page registers the single handler,
 * and requests made while none is registered are dropped.
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

/** Ask the home page to open a view by its id (e.g. `security`, `profile`). */
export function requestOpenView(viewId: string): void {
    handler?.(viewId);
}

/**
 * Même mécanique pour la bascule d'espace, dont la téléportation a besoin.
 * Passer par ici plutôt que d'appeler `setActiveWorkspace` garantit la séquence
 * complète que l'accueil applique déjà : remise à zéro des appareils,
 * `workspace.activate`, thème et disposition.
 */
type SelectWorkspaceHandler = (workspaceId: number) => void;

let workspaceHandler: SelectWorkspaceHandler | null = null;

export function onSelectWorkspaceRequest(fn: SelectWorkspaceHandler): () => void {
    workspaceHandler = fn;
    return () => {
        if (workspaceHandler === fn) workspaceHandler = null;
    };
}

export function requestSelectWorkspace(workspaceId: number): void {
    workspaceHandler?.(workspaceId);
}
