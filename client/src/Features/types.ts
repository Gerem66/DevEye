import type { User, Workspace } from 'deveye-types';
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
}
