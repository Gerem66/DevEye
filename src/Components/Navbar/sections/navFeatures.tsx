import { JSX } from 'react';

import { FEATURE_BY_ID } from '@/Features/Features';
import stylesBtn from '../button.module.css';
import styles from './styleFeatures.module.css';

import type { FeatureType } from '@/Features/types';
import type { Workspace } from 'deveye-types';

interface NavFeaturesProps {
    workspace: Workspace | null;
    active: {
        featureId: string | null;
        workspaceId: number;
    };
    onProfileClick: () => void;
    onFeatureClick: (workspaceId: number, featureId: string) => void;
}

function NavFeatures({ workspace, active, onProfileClick, onFeatureClick }: NavFeaturesProps) {
    return (
        <div>
            <button className={styles.profile} onClick={onProfileClick}>
                <div className={styles['profile-content']}>
                    <img className={styles['profile-image']} src={'./images/' + workspace?.logo} alt='Logo' />
                    <span>{workspace?.name || 'Workspace'}</span>
                </div>
                <span className={`icon icon-arrow ${styles['profile-icon']}`} />
            </button>

            {workspace ? renderCategory(workspace, active, onFeatureClick) : null}
        </div>
    );
}

function renderCategory(
    workspace: Workspace,
    active: NavFeaturesProps['active'],
    onFeatureClick: NavFeaturesProps['onFeatureClick']
): JSX.Element {
    const features = workspace.features
        .map((id) => FEATURE_BY_ID[id])
        .filter((f): f is FeatureType => Boolean(f))
        .map((feature) => renderFeature(workspace, feature, active, onFeatureClick));

    return (
        <section key={'section-' + workspace.id} className={styles.category} data-title={workspace.name}>
            {features}
        </section>
    );
}

function renderFeature(
    workspace: Workspace,
    feature: FeatureType,
    active: NavFeaturesProps['active'],
    onFeatureClick: NavFeaturesProps['onFeatureClick']
): JSX.Element {
    const isActive = active.featureId === feature.id && active.workspaceId === workspace.id;
    return (
        <button
            key={'btn-feature-' + feature.id}
            className={`${stylesBtn.button} ${isActive ? stylesBtn.active : ''}`}
            onClick={() => onFeatureClick(workspace.id, feature.id)}
        >
            <span className={`icon icon-${feature.icon} ${stylesBtn.icon}`} />
            <span>{feature.name}</span>
        </button>
    );
}

export default NavFeatures;
