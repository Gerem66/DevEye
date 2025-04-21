import React, { JSX } from 'react';

import styles from './styleFeatures.module.css';
import stylesBtn from '../button.module.css';
import { FEATURES } from '../../../Features/Features';

type FeaturesID = import('Types/Feature').FeaturesID;
type FeatureType = import('Types/Feature').FeatureType;
type ContextType = import('Types/Context').ContextType;

const NavFeaturesProps = {
    context: null as ContextType | null,
    active: {
        feature_id: null as FeaturesID | null,
        context_id: 0
    },
    onProfileClick: (() => {}) as () => void,
    onFeatureClick: (() => {}) as (context_id: number, feature_id: FeaturesID) => void
};

class NavFeatures extends React.Component<typeof NavFeaturesProps> {
    render() {
        const { context, onProfileClick } = this.props;

        return (
            <div>
                {/* Profile */}
                <button className={styles.profile} onClick={onProfileClick}>
                    <div className={styles['profile-content']}>
                        <img className={styles['profile-image']} src={'./images/' + context?.logo} alt='Logo' />
                        <span>{context?.name || 'Context'}</span>
                    </div>
                    <span className={`icon icon-arrow ${styles['profile-icon']}`} />
                </button>

                {/* Features */}
                {this.renderCategory(context)}
            </div>
        );
    }

    renderCategory = (context: ContextType | null): JSX.Element | null => {
        if (!context) return null;

        const features = context.features
            .map((id) => FEATURES.find((f) => f.id === id))
            .filter((f) => f !== undefined)
            .map((feature) => this.renderFeature(context, feature));

        return (
            <section key={'section-' + context.id} className={styles.category} data-title={context.name}>
                {features}
            </section>
        );
    };

    renderFeature = (context: ContextType, feature: FeatureType): JSX.Element => {
        const { active, onFeatureClick } = this.props;

        const isActive = active.feature_id === feature.id && active.context_id === context.id;
        const onClick = () => onFeatureClick(context.id, feature.id);

        return (
            <button
                key={'btn-feature-' + feature.id}
                className={`${stylesBtn.button} ${isActive ? stylesBtn.active : ''}`}
                onClick={onClick}
            >
                <span className={`icon icon-${feature.icon} ${stylesBtn.icon}`} />
                <span>{feature.name}</span>
            </button>
        );
    };
}

export default NavFeatures;
