import { JSX } from 'react';

import styles from './style.module.css';

import type { ColorClass, IconName } from '@/Styles/classNames';

interface CardValueProps {
    title: string;
    value: string;
    icon?: IconName | null;
    width?: 'auto' | 'unset' | number;
    color?: ColorClass;
}

function CardValue({ title, value, icon = null, width = 'unset', color = 'bg-blue' }: CardValueProps): JSX.Element {
    return (
        <div className={`${styles.card} ${color}`} style={{ maxWidth: width }}>
            <p className={styles.title}>{title}</p>
            <p className={styles.value}>{value}</p>

            {icon === null ? (
                <></>
            ) : (
                <div className={styles['icon-container']}>
                    <i className={`icon ${styles.icon} icon-${icon}`} />
                </div>
            )}
        </div>
    );
}

export default CardValue;
