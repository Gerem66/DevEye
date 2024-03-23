import React from 'react';

import styles from './style.module.css';

/**
 * @typedef {import('../index').CardSize} CardSize
 * @typedef {import('Styles/colors').Color} Color
 * @typedef {import('Styles/icons').Icon} Icon
 * 
 * @typedef {object} CardValueProps
 * @property {string} title
 * @property {string} value
 * @property {Icon|null} [icon]
 * @property {CardSize} [size]
 * @property {Color} [color]
 */

/**
 * @param {CardValueProps} props
 * @returns {React.JSX.Element}
 */
function CardValue({ title, value, icon = null, size = '1/4', color = 'blue' }) {
    const sizeNb = `${size.replace('/', '')}`;

    return (
        <div className={`${styles.card} bg-${color} col-${sizeNb}`}>
            <p className={styles.title}>{title}</p>
            <p className={styles.value}>{value}</p>

            {icon === null ? <></> : (
                <div className={styles['icon-container']}>
                    <i className={`${styles.icon} icon-${icon}`} />
                </div>
            )}
        </div>
    );
}

export default CardValue;