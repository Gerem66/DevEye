import React from 'react';

import styles from './style.module.css';

/**
 * @typedef {import('Styles/colors').Color} Color
 * @typedef {import('Styles/icons').Icon} Icon
 * 
 * @typedef {object} CardValueProps
 * @property {string} title
 * @property {string} value
 * @property {Icon|null} [icon]
 * @property {'auto' | 'unset' | number} [width] The width of the card in percentage
 * @property {Color} [color]
 */

/**
 * @param {CardValueProps} props
 * @returns {React.JSX.Element}
 */
function CardValue({ title, value, icon = null, width = 'unset', color = 'blue' }) {
    return (
        <div
            className={`${styles.card} bg-${color}`}
            style={{ maxWidth: width }}
        >
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
