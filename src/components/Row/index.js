import React from 'react';

import './style.css';

/**
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