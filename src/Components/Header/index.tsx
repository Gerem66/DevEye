import { JSX, useState } from 'react';

import styles from './style.module.css';

import { ws } from '@/api/ws';
import { useAuth } from '@/auth/AuthProvider';

import type { FeatureType } from '@/Features/types';
import type { User, Workspace } from 'deveye-types';

interface HeaderProps {
    user: User;
    workspace: Workspace;
    feature: FeatureType;
}

function Header({ user, workspace, feature }: HeaderProps): JSX.Element {
    const { updateUser } = useAuth();
    const [loading, setLoading] = useState(false);
    const isFavorite = user.defaultWorkspace === workspace.id && user.defaultFeature === feature.id;

    const onFavoriteClick = async () => {
        if (loading || isFavorite) return;
        setLoading(true);
        try {
            await ws.send('workspace.setFavoriteFeature', {
                workspaceId: workspace.id,
                featureId: feature.id,
            });
            updateUser({ defaultWorkspace: workspace.id, defaultFeature: feature.id });
        } catch {
            /* swallow: UI will simply remain non-favorite */
        } finally {
            setLoading(false);
        }
    };

    return (
        <header className={styles.header}>
            <h1 className={styles.title}>{feature?.name}</h1>
            <div className={styles.pathGroup}>
                <i
                    className={`
                        ${isFavorite ? styles.favorite : styles.notFavorite}
                        ${loading ? styles['favorite-loading'] : ''}
                    `}
                    onClick={onFavoriteClick}
                />
                <p className={styles.text}>{`${workspace?.name} / ${feature.id}`}</p>
            </div>
        </header>
    );
}

export default Header;
