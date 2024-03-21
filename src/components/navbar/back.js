import React from 'react';

import './style.css';
import './button.css';
import { FEATURES } from '../../features/Feature';

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

    /** @type {(context: ContextType) => void} */
    setContext: (context) => {},

    /** @type {(feature: FeatureType) => void} */
    setFeature: (feature) => {}
};

class NavbarBack extends React.Component {
    state = {
        active: {
            /** @type {string} */
            feature_id: '',

            /** @type {string} */
            context_id: ''
        },

        /** @type {boolean} */
        is_navpanel_switch: false
    };

    componentDidMount() {
        this.__selectDefaultFeature();
    }

    /** @param {NavbarProps} prevProps */
    componentDidUpdate(prevProps) {
        if (prevProps.context !== this.props.context) {
            this.__selectDefaultFeature();
        }
    }

    __selectDefaultFeature = () => {
        const { context } = this.props;
        if (context === null || context.features.length === 0) return;

        this.onFeatureClick(context.id, context.features[0]);
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
     * @param {string} context_id
     * @param {FeaturesID} feature_id
     */
    onFeatureClick = (context_id, feature_id) => {
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
        this.props.setFeature(feature);
    }
}

NavbarBack.defaultProps = NavbarProps;
NavbarBack.prototype.props = NavbarProps;

export default NavbarBack;
