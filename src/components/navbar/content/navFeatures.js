import React from 'react';

import './styleFeatures.css';
import Features from '../../../class/project';

/**
 * @typedef {import('../../../class/project').Feature} Feature
 */

const NavFeaturesProps = {
    /** @type {string|null} */
    active_feature_id: null,

    /** @type {() => void} */
    onProfileClick: () => {},

    /** @type {(feature: Feature) => void} */
    onFeatureClick: (feature) => {}
};

class NavFeatures extends React.Component {
    /**
     * @param {string} category
     * @returns {JSX.Element}
     */
    renderCategory = (category) => {
        const features = Features[category].map(this.renderFeature);

        return (
            <section
                key={'section-' + category}
                className='category'
                data-title='Personal'
            >
                {features}
            </section>
        );
    }

    /**
     * @param {Feature} feature 
     * @returns {JSX.Element}
     */
    renderFeature = (feature) => {
        const { active_feature_id, onFeatureClick } = this.props;
        const active = active_feature_id === feature.id ? 'active' : '';
        const onClick = () => onFeatureClick(feature);

        return (
            <button
                key={'btn-feature-' + feature.id}
                className={'button ' + active}
                onClick={onClick}
            >
                <span className={'icon icon-' + feature.icon} />
                <span>{feature.name}</span>
            </button>
        );
    }

    render() {
        const { onProfileClick } = this.props;
        const features = Object.keys(Features).map(this.renderCategory);

        return (
            <div>

                {/* Profile */}
                <button className='profile' onClick={onProfileClick}>
                    <div className='profile-content'>
                        <img
                            className='profile-image'
                            src='./avatars/gerem.png'
                            alt='Logo'
                        />
                        <span>User</span>
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