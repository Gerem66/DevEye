import React from 'react';

import './styleFeatures.css';
import { FEATURES } from '../../../Features/Features';

/**
 * @typedef {import('Types/Feature').FeaturesID} FeaturesID
 * @typedef {import('Types/Feature').FeatureType} FeatureType
 * @typedef {import('Types/Context').ContextType} ContextType
 */

const NavFeaturesProps = {
    /** @type {ContextType|null} */
    context: null,

    /**
     * @type {{ feature_id: string, context_id: string }}
     */
    active: {
        feature_id: '',
        context_id: ''
    },

    /** @type {() => void} */
    onProfileClick: () => {},

    /** @type {(context: string, feature_id: FeaturesID) => void} */
    onFeatureClick: (context_id, feature_id) => {}
};

class NavFeatures extends React.Component {
    render() {
        const { context, onProfileClick } = this.props;

        return (
            <div className='nav-features'>

                {/* Profile */}
                <button className='profile' onClick={onProfileClick}>
                    <div className='profile-content'>
                        <img
                            className='profile-image'
                            src={'./images/' + context?.logo}
                            alt='Logo'
                        />
                        <span>{context?.name || 'Context'}</span>
                    </div>
                    <span className='icon icon-arrow' />
                </button>

                {/* Features */}
                {this.renderCategory(context)}

            </div>
        );
    }

    /**
     * @param {ContextType | null} context
     * @returns {JSX.Element | null}
     */
    renderCategory = (context) => {
        if (!context) return null;

        const features = context.features
            .map(id => FEATURES.find(f => f.id === id))
            .filter(f => f !== undefined)
            .map(feature => this.renderFeature(context, feature));

        return (
            <section
                key={'section-' + context.id}
                className='category'
                data-title={context.name}
            >
                {features}
            </section>
        );
    }

    /**
     * @param {ContextType} context
     * @param {FeatureType} feature 
     * @returns {JSX.Element}
     */
    renderFeature = (context, feature) => {
        const { active, onFeatureClick } = this.props;

        const isActive = active.feature_id === feature.id &&
                         active.context_id === context.id;
        const onClick = () => onFeatureClick(context.id, feature.id);

        return (
            <button
                key={'btn-feature-' + feature.id}
                className={'button' + (isActive ? ' active' : '')}
                onClick={onClick}
            >
                <span className={'icon icon-' + feature.icon} />
                <span>{feature.name}</span>
            </button>
        );
    }
}

NavFeatures.prototype.props = NavFeaturesProps;
NavFeatures.defaultProps = NavFeaturesProps;

export default NavFeatures;
