import React from 'react';

import styles from './style.module.css';

/**
 * @typedef {Object} RowProps
 * @property {React.ReactNode} children
 * @property {string} [style]
 * @property {boolean} [center]
 */

/**
 * @param {RowProps} props
 * @returns {React.JSX.Element}
 */
function Row({ children, style = '', center = false }) {
    return (
        <div
            className={`${styles.row} ${style}`}
            style={{ justifyContent: center ? 'center' : 'unset' }}
        >
            {children}
        </div>
    );
}

export default Row;
