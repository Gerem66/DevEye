import React from 'react';

import Features from '../../../class/feature';

import './styleFeatures.css';

/**
 * @typedef {import('../../../class/feature').FeaturesID} FeaturesID
 * @typedef {import('../../../class/feature').FeatureType} FeatureType
 * @typedef {import('../../../class/feature').ProjectContext} ProjectContext
 */

const NavFeaturesProps = {
    /** @type {ProjectContext} */
    context: null,

    /**
     * @type {{ feature_id: string, context_id: string }}
     */
    active: {
        feature_id: null,
        context_id: null
    },

    /** @type {() => void} */
    onProfileClick: () => {},

    /** @type {(context: string, feature_id: FeaturesID) => void} */
    onFeatureClick: (context_id, feature_id) => {}
};

class NavFeatures extends React.Component {
    /**
     * @param {ProjectContext} context
     * @returns {JSX.Element}
     */
    renderCategory = (context) => {
        const features = context.features
            .map(id => Features.find(f => f.id === id))
            .map(feature => this.renderFeature(context, feature));

        return (
            <section
                key={'section-' + context}
                className='category'
                data-title={context.name}
            >
                {features}
            </section>
        );
    }

    /**
     * @param {ProjectContext} context
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

    render() {
        const { context, onProfileClick } = this.props;
        const features = this.renderCategory(context);

        return (
            <div>

                {/* Profile */}
                <button className='profile' onClick={onProfileClick}>
                    <div className='profile-content'>
                        <img
                            className='profile-image'
                            src={'./images/' + context.logo}
                            alt='Logo'
                        />
                        <span>{context.name}</span>
                    </div>
                    <span className='icon icon-arrow' />
                </button>

                {/* Features */}
                {features}

            </div>
        );
    }
}

NavFeatures.prototype.props = NavFeaturesProps;
NavFeatures.defaultProps = NavFeaturesProps;

export default NavFeatures;