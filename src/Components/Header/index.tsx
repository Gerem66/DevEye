import { JSX, useState } from 'react';

import styles from './style.module.css';

import { tcp } from 'Utils/TCP';

import type { UserType, ContextType, FeatureType } from 'deveye-types';

type SetUserType = (use: UserType) => void;

interface HeaderProps {
    user: UserType;
    setUser: SetUserType;
    context: ContextType;
    feature: FeatureType;
}

function Header({ user, setUser, context, feature }: HeaderProps): JSX.Element {
    const [loading, setLoading] = useState(false);
    const isFavorite = user.DefaultContext === context.id && user.DefaultFeature === feature.id;

    const onFavoriteClick = async () => {
        if (loading || isFavorite) {
            return;
        }

        setLoading(true);
        const result = await tcp.SendAsync('change-favorite-context', {
            contextID: context.id,
            featureID: feature.id
        });

        if (result === 'not-sended' || result === 'timeout' || result.status !== 0) {
            setLoading(false);
            return;
        }

        setUser({
            ...user,
            DefaultContext: context.id,
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
                <p className={styles.text}>{`${context?.name} / ${feature.id}`}</p>
            </div>
        </header>
    );
}

export default Header;
