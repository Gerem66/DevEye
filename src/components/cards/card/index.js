import React from 'react';

import './style.css';

/**
 * @typedef {import('../index').CardSize} CardSize
 * @typedef {import('../index').CardColor} CardColor
 * 
 * @typedef {object} CardValueProps
 * @property {React.JSX.Element|React.JSX.Element[]} children
 * @property {CardSize} [size]
 * @property {CardColor} [color]
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