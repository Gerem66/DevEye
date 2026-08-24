import type { User, Workspace } from '@deveye/types';
import type { ComponentType } from 'react';

/**
 * Static metadata describing a UI-level "feature" (a left-nav entry mapped to
 * a screen component). Decoupled from the WS feature registry intentionally:
 * this lives in the client and may render screens that aggregate several
 * `featureCommandRegistry` commands.
 */
export interface FeatureType {
    id: string;
    name: string;
    icon: string;
    component: ComponentType<FeatureProps>;
}

export interface FeatureProps {
    user: User;
    workspace: Workspace;
    feature: FeatureType;
    setWorkspace: (workspace: Workspace) => void;
    setFeature: (feature: FeatureType) => void;
    /**
     * Ask the host to close this feature's popup. No-op unless this feature is
     * the one currently shown. The feature is force-unmounted on close (ignoring
     * its cache TTL) so a later reopen starts a fresh load. Used when there is
     * nothing to show — e.g. the user cancelled the encryption unlock prompt.
     */
    closeFeature: () => void;
}

/**
 * Lifecycle contract a feature can opt into via the `useFeatureLifecycle` hook.
 *
 * - `onUnmount`: called once when the cached feature instance is torn down for
 *   any reason — TTL expiry, immediate close (`cacheDurationMinutes: 0`), a
 *   forced Ctrl+click reset, or the dashboard unmounting. Use it to flush
 *   pending edits, persist state, cancel subscriptions, etc.
 *
 * The cache *duration* itself (how long a feature stays mounted after close)
 * is declared per feature as `cacheDurationMinutes` in the Home widget
 * registry, which is the single source of truth read by the cache scheduler:
 *   - `0`         → unmount immediately on close.
 *   - `> 0`       → stay mounted for that many minutes, then auto-unmount.
 *   - `undefined` → stay mounted indefinitely until a forced reset.
 */
export interface FeatureLifecycle {
    onUnmount?: () => void;
}
