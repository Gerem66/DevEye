import { useEffect, useState } from 'react';

import { useAuth } from '@/auth/AuthProvider';
import { FEATURE_BY_ID, FEATURES } from '@/Features/Features';
import NavFeatures from './sections/navFeatures';
import NavWorkspaces from './sections/navWorkspaces';
import styles from './style.module.css';

import packageJson from '../../../package.json';

import type { FeatureType } from '@/Features/types';
import type { Workspace } from 'deveye-types';

const ENV = import.meta.env.VITE_ENV;
const ENV_IS_DEV = ENV === 'dev';
const version = packageJson.version + ((ENV_IS_DEV && '-dev') || '');

interface NavbarProps {
    workspace: Workspace | null;
    feature: FeatureType | null;
    setWorkspace: (workspace: Workspace) => void;
    setFeature: (feature: FeatureType) => void;
}

function Navbar({ workspace, feature, setWorkspace, setFeature }: NavbarProps) {
    const { user, workspaces } = useAuth();
    const [active, setActive] = useState<{ workspaceId: number; featureId: string | null }>({
        workspaceId: workspace?.id ?? 0,
        featureId: feature?.id ?? null
    });
    const [isNavpanelSwitch, setIsNavpanelSwitch] = useState(false);

    useEffect(() => {
        setActive({
            workspaceId: workspace?.id ?? 0,
            featureId: feature?.id ?? null
        });
    }, [workspace, feature]);

    const onFeatureClick = (workspaceId: number, featureId: string) => {
        const nextWorkspace = workspaces.find((w) => w.id === workspaceId);
        const nextFeature = FEATURE_BY_ID[featureId];
        if (!nextWorkspace || !nextFeature) return;
        if (workspace?.id !== nextWorkspace.id) setWorkspace(nextWorkspace);
        setFeature(nextFeature);
    };

    const onProfileClick = () => {
        setIsNavpanelSwitch(true);
    };

    const onWorkspaceClick = (next: Workspace | null) => {
        if (next === null) {
            setIsNavpanelSwitch(false);
            return;
        }
        setWorkspace(next);
        const defaultId = user && next.features.includes(user.defaultFeature) ? user.defaultFeature : next.features[0];
        const nextFeature = (defaultId && FEATURE_BY_ID[defaultId]) || FEATURES[0];
        if (nextFeature) setFeature(nextFeature);
        setIsNavpanelSwitch(false);
    };

    return (
        <nav id='navbar' className={`${styles.navbar} ${user === null ? '' : styles.open}`}>
            <div className={styles['navbar-header']}>
                <a href='/' className={styles['navbar-brand']}>
                    <img className={styles['navbar-brand-img']} src='./logo_deveye.png' alt='Logo' />
                    <span>DevEye</span>
                </a>
                <div className={styles.version}>
                    <span>{version}</span>
                </div>
            </div>

            <div className={`${styles.navpanel} ${isNavpanelSwitch ? styles.switch : ''}`}>
                <div className={styles['navpanel-content']}>
                    <NavFeatures
                        workspace={workspace}
                        active={active}
                        onFeatureClick={onFeatureClick}
                        onProfileClick={onProfileClick}
                    />
                </div>
                <div className={styles['navpanel-content']}>
                    <NavWorkspaces onWorkspaceClick={onWorkspaceClick} />
                </div>
            </div>
        </nav>
    );
}

export default Navbar;
