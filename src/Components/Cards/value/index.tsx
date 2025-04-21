import { JSX } from 'react';

import styles from './style.module.css';

type Color = keyof typeof import('Styles/colors.css');
type Icon = keyof typeof import('Styles/icons.css');

interface CardValueProps {
    title: string;
    value: string;
    icon?: Icon | null;
    width?: 'auto' | 'unset' | number;
    color?: Color;
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
