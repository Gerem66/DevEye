import React, { JSX } from 'react';

import styles from './styleFeatures.module.css';
import stylesBtn from '../button.module.css';
import { FEATURES } from '../../../Features/Features';

import type { FeaturesID, FeatureType, DBType_Workspace } from 'deveye-types';

interface NavFeaturesProps {
    workspace: DBType_Workspace | null;
    active: {
        feature_id: FeaturesID | null;
        workspace_id: number;
    };
    onProfileClick: () => void;
    onFeatureClick: (workspace_id: number, feature_id: FeaturesID) => void;
}

class NavFeatures extends React.Component<NavFeaturesProps> {
    render() {
        const { workspace, onProfileClick } = this.props;

        return (
            <div>
                {/* Profile */}
                <button className={styles.profile} onClick={onProfileClick}>
                    <div className={styles['profile-content']}>
                        <img className={styles['profile-image']} src={'./images/' + workspace?.logo} alt='Logo' />
                        <span>{workspace?.name || 'Workspace'}</span>
                    </div>
                    <span className={`icon icon-arrow ${styles['profile-icon']}`} />
                </button>

                {/* Features */}
                {this.renderCategory(workspace)}
            </div>
        );
    }

    renderCategory = (workspace: DBType_Workspace | null): JSX.Element | null => {
        if (!workspace) return null;

        const features = workspace.features
            .map((id) => FEATURES.find((f) => f.id === id))
            .filter((f) => f !== undefined)
            .map((feature) => this.renderFeature(workspace, feature));

        return (
            <section key={'section-' + workspace.id} className={styles.category} data-title={workspace.name}>
                {features}
            </section>
        );
    };

    renderFeature = (workspace: DBType_Workspace, feature: FeatureType): JSX.Element => {
        const { active, onFeatureClick } = this.props;

        const isActive = active.feature_id === feature.id && active.workspace_id === workspace.id;
        const onClick = () => onFeatureClick(workspace.id, feature.id);

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
