import type { User, Workspace } from '@deveye/types';
import type { ComponentType } from 'react';

/**
 * Static metadata describing a UI-level "feature": an entry mapped to a screen
 * component. Deliberately decoupled from the WS feature registry, a screen being
 * free to aggregate several `featureCommandRegistry` commands.
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
     * Ask the host to close this feature's popup; a no-op unless this feature is
     * the one shown. It is force-unmounted on close, ignoring its cache TTL, so a
     * later reopen starts a fresh load.
     */
    closeFeature: () => void;
}

/**
 * Lifecycle contract a feature can opt into via the `useFeatureLifecycle` hook.
 * `onUnmount` fires once when the cached instance is torn down, for any reason.
 *
 * How long a feature stays mounted after close is declared per feature as
 * `cacheDurationMinutes` in the Home widget registry, the single source of truth
 * for the cache scheduler: `0` unmounts on close, `> 0` waits that many minutes,
 * `undefined` stays mounted until a forced reset.
 */
export interface FeatureLifecycle {
    onUnmount?: () => void;
}
