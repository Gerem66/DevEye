import React from 'react';

import { FEATURES } from '../../Features/Features';

import type { DBType_User, FeaturesID, FeatureType, DBType_Workspace } from 'deveye-types';

const NavbarProps = {
    user: null as DBType_User | null,
    workspace: null as DBType_Workspace | null,
    feature: null as FeatureType | null,
    setWorkspace: (() => {}) as (workspace: DBType_Workspace) => void,
    setFeature: (() => {}) as (feature: FeatureType) => void
};

class NavbarBack extends React.Component<typeof NavbarProps> {
    state = {
        active: {
            workspace_id: 0,
            feature_id: null as FeaturesID | null
        },

        /** @type {boolean} */
        is_navpanel_switch: false
    };

    componentDidUpdate(prevProps: typeof NavbarProps) {
        void prevProps;

        const { workspace, feature } = this.props;
        if (workspace !== null && feature !== null) {
            if (workspace.id !== this.state.active.workspace_id || feature.id !== this.state.active.feature_id) {
                this.setState({
                    active: {
                        workspace_id: workspace.id,
                        feature_id: feature.id
                    },
                    is_navpanel_switch: false
                });
            }
        }
    }

    onProfileClick = () => {
        this.setState({ is_navpanel_switch: true });
    };

    onWorkspaceClick = (workspace: DBType_Workspace | null = null) => {
        this.setState({ is_navpanel_switch: false });

        if (workspace !== null) {
            this.props.setWorkspace(workspace);
        }
    };

    onFeatureClick = (workspace_id: number, feature_id: FeaturesID, sendCallbackToParent: boolean = true) => {
        const { user } = this.props;

        // Check if feature is already active
        if (feature_id === this.state.active.feature_id && workspace_id === this.state.active.workspace_id) {
            return;
        }

        const workspace = user?.Workspaces.find((f) => f.id === workspace_id);

        // Check if workspace & feature exists in this workspace
        if (!workspace) {
            throw new Error('Workspace not found');
        }
        if (!workspace.features.includes(feature_id)) {
            throw new Error('Feature not found');
        }

        // Check if feature exists
        const feature = FEATURES.find((f) => f.id === feature_id);
        if (!feature) {
            throw new Error('Feature not found');
        }

        // Set active feature
        this.setState({
            active: {
                feature_id: feature.id,
                workspace_id: workspace.id
            }
        });

        // Set content
        if (sendCallbackToParent) {
            this.props.setFeature(feature);
        }
    };
}

export default NavbarBack;
