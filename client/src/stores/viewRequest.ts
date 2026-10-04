/**
 * Cross-feature view navigation: a view rendered inside the home popup can ask
 * the home page to open another one. The home page registers the single handler,
 * and requests made while none is registered are dropped.
 */
import type { PopupOrigin } from '@/Components/WidgetPopup/WidgetPopup';
import { getActiveInstanceId } from './workspace';

export interface OpenViewOptions {
    forceReset?: boolean;
    /** Le point de l'écran d'où la popup grandit, à la place du morphe depuis la tuile. */
    origin?: PopupOrigin;
}

type OpenViewHandler = (viewId: string, opts: OpenViewOptions) => void;

let handler: OpenViewHandler | null = null;

/** Register the navigation handler (the home page). Returns the unregister. */
export function onOpenViewRequest(fn: OpenViewHandler): () => void {
    handler = fn;
    return () => {
        if (handler === fn) handler = null;
    };
}

/** Ask the home page to open a view by its id (e.g. `security`, `profile`). */
export function requestOpenView(viewId: string, opts: OpenViewOptions = {}): void {
    handler?.(viewId, opts);
}

/**
 * Même mécanique pour la bascule d'espace, dont la téléportation a besoin.
 * Passer par ici plutôt que d'appeler `setActiveWorkspace` garantit la séquence
 * complète que l'accueil applique déjà : remise à zéro des appareils,
 * `workspace.activate`, thème et disposition.
 */
type SelectWorkspaceHandler = (workspaceId: number, instanceId: number | null) => void;

let workspaceHandler: SelectWorkspaceHandler | null = null;

export function onSelectWorkspaceRequest(fn: SelectWorkspaceHandler): () => void {
    workspaceHandler = fn;
    return () => {
        if (workspaceHandler === fn) workspaceHandler = null;
    };
}

/** Sans instance nommée, l'espace est cherché là où l'on se trouve : c'est de là que vient son id. */
export function requestSelectWorkspace(workspaceId: number, instanceId: number | null = getActiveInstanceId()): void {
    workspaceHandler?.(workspaceId, instanceId);
}
