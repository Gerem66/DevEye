import { JSX } from 'react';

import styles from './style.module.css';

import type Color from 'Styles/colors.css';
import type Icon from 'Styles/icons.css';

interface CardValueProps {
    title: string;
    value: string;
    icon?: keyof typeof Icon | null;
    width?: 'auto' | 'unset' | number;
    color?: keyof typeof Color;
}

function CardValue({ title, value, icon = null, width = 'unset', color = 'bg-blue' }: CardValueProps): JSX.Element {
    return (
        <div className={`${styles.card} bg-${color}`} style={{ maxWidth: width }}>
            <p className={styles.title}>{title}</p>
            <p className={styles.value}>{value}</p>

            {icon === null ? (
                <></>
            ) : (
                <div className={styles['icon-container']}>
                    <i className={`${styles.icon} icon-${icon}`} />
                </div>
            )}
        </div>
    );
}

export default CardValue;
