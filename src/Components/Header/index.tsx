import { JSX, useState } from 'react';

import styles from './style.module.css';

import { tcp } from '@/Utils/TCP';

import type { DBType_User, DBType_Workspace, FeatureType } from 'deveye-types';

type SetUserType = (use: DBType_User) => void;

interface HeaderProps {
    user: DBType_User;
    setUser: SetUserType;
    workspace: DBType_Workspace;
    feature: FeatureType;
}

function Header({ user, setUser, workspace, feature }: HeaderProps): JSX.Element {
    const [loading, setLoading] = useState(false);
    const isFavorite = user.DefaultWorkspace === workspace.id && user.DefaultFeature === feature.id;

    const onFavoriteClick = async () => {
        if (loading || isFavorite) {
            return;
        }

        setLoading(true);
        const result = await tcp.SendAndWait('set-favorite-workspace', {
            workspaceID: workspace.id,
            featureID: feature.id
        });

        if (result === 'not-sended' || result === 'timeout' || result.status !== 'success') {
            setLoading(false);
            return;
        }

        setUser({
            ...user,
            DefaultWorkspace: workspace.id,
            DefaultFeature: feature.id
        });

        setLoading(false);
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
