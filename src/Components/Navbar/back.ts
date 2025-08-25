import React from 'react';

import { FEATURES } from '../../Features/Features';

import type { UserType, FeaturesID, FeatureType, ContextType } from 'deveye-types';

const NavbarProps = {
    user: null as UserType | null,
    context: null as ContextType | null,
    feature: null as FeatureType | null,
    setContext: (() => {}) as (context: ContextType) => void,
    setFeature: (() => {}) as (feature: FeatureType) => void
};

class NavbarBack extends React.Component<typeof NavbarProps> {
    state = {
        active: {
            context_id: 0,
            feature_id: null as FeaturesID | null
        },

        /** @type {boolean} */
        is_navpanel_switch: false
    };

    componentDidUpdate(prevProps: typeof NavbarProps) {
        void prevProps;

        const { context, feature } = this.props;
        if (context !== null && feature !== null) {
            if (context.id !== this.state.active.context_id || feature.id !== this.state.active.feature_id) {
                this.setState({
                    active: {
                        context_id: context.id,
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

    onContextClick = (context: ContextType | null = null) => {
        this.setState({ is_navpanel_switch: false });

        if (context !== null) {
            this.props.setContext(context);
        }
    };

    onFeatureClick = (context_id: number, feature_id: FeaturesID, sendCallbackToParent: boolean = true) => {
        const { user } = this.props;

        // Check if feature is already active
        if (feature_id === this.state.active.feature_id && context_id === this.state.active.context_id) {
            return;
        }

        const context = user?.Contexts.find((f) => f.id === context_id);

        // Check if context & feature exists in this context
        if (!context) {
            throw new Error('Context not found');
        }
        if (!context.features.includes(feature_id)) {
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
                context_id: context.id
            }
        });

        // Set content
        if (sendCallbackToParent) {
            this.props.setFeature(feature);
        }
    };
}

export default NavbarBack;
