import React from 'react';

import { FEATURES } from '../../Features/Features';

/**
 * @typedef {import('Types/User').UserType} UserType
 * @typedef {import('Types/Feature').FeaturesID} FeaturesID
 * @typedef {import('Types/Feature').FeatureType} FeatureType
 * @typedef {import('Types/Context').ContextType} ContextType
 */

const NavbarProps = {
    /** @type {UserType | null} */
    user: null,

    /** @type {ContextType | null} */
    context: null,

    /** @type {FeatureType | null} */
    feature: null,

    /** @type {(context: ContextType) => void} */
    setContext: (context) => {},

    /** @type {(feature: FeatureType) => void} */
    setFeature: (feature) => {}
};

class NavbarBack extends React.Component {
    state = {
        active: {
            /** @type {number} */
            context_id: 0,

            /** @type {FeaturesID | null} */
            feature_id: null
        },

        /** @type {boolean} */
        is_navpanel_switch: false
    };

    /** @param {NavbarProps} prevProps */
    componentDidUpdate(prevProps) {
        const { context, feature } = this.props;
        if (context !== null && feature !== null) {
            if (context.id !== this.state.active.context_id || feature.id !== this.state.active.feature_id) {
                this.setState({
                    active: {
                        context_id: context.id,
                        feature_id: feature.id
                    }
                });
            }
        }
    }

    onProfileClick = () => {
        this.setState({ is_navpanel_switch: true });
    }

    /** @param {ContextType | null} context */
    onContextClick = (context = null) => {
        this.setState({ is_navpanel_switch: false });

        if (context !== null) {
            this.props.setContext(context);
        }
    }

    /**
     * @param {number} context_id
     * @param {FeaturesID} feature_id
     * @param {boolean} [sendCallbackToParent]
     */
    onFeatureClick = (context_id, feature_id, sendCallbackToParent = true) => {
        const { user } = this.props;

        // Check if feature is already active
        if (feature_id === this.state.active.feature_id &&
            context_id === this.state.active.context_id) {
            return;
        }

        const context = user?.Contexts.find(f => f.id === context_id);

        // Check if context & feature exists in this context
        if (!context)
            throw new Error('Context not found');
        if (!context.features.includes(feature_id))
            throw new Error('Feature not found');

        // Check if feature exists
        const feature = FEATURES.find(f => f.id === feature_id);
        if (!feature)
            throw new Error('Feature not found');

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
    }
}

NavbarBack.defaultProps = NavbarProps;
NavbarBack.prototype.props = NavbarProps;

export default NavbarBack;
