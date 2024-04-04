import React from 'react';

import styles from './style.module.css';

/**
 * @typedef {Object} RowProps
 * @property {React.ReactNode} children
 * @property {string} [className]
 * @property {React.CSSProperties} [style]
 * @property {boolean} [center]
 */

/**
 * @param {RowProps} props
 * @returns {React.JSX.Element}
 */
function Row({ children, className = '', style = {}, center = false }) {
    return (
        <div
            className={`${styles.row} ${className}`}
            style={{
                justifyContent: center ? 'center' : 'unset',
                ...style
            }}
        >
            {children}
        </div>
    );
}

export default Row;
