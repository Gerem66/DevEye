import React from 'react';

import './style.css';

/**
 * @typedef {Object} RowProps
 * @property {React.ReactNode} children
 * @property {string} [style]
 */

/**
 * @param {RowProps} props
 * @returns {React.JSX.Element}
 */
function Row({ children, style = '' }) {
    return (
        <div className={`row ${style}`}>
            {children}
        </div>
    );
}

export default Row;
