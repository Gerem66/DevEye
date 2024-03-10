import React from 'react';

import './style.css';

/**
 * @typedef {import('../index').CardSize} CardSize
 * @typedef {import('../../../styles/colors').Color} Color
 * 
 * @typedef {object} CardValueProps
 * @property {React.JSX.Element|React.JSX.Element[]} children
 * @property {CardSize} [size]
 * @property {Color} [color]
 */

/**
 * @param {CardValueProps} props
 * @returns {React.JSX.Element}
 */
function CardElement({ children, size = '1/4', color = 'blue' }) {
    const sizeNb = `${size.replace('/', '')}`;

    return (
        <div className={`card bg-${color} col-${sizeNb}`}>
            {children}
        </div>
    );
}

export default CardElement;