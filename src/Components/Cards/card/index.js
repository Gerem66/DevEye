import React from 'react';

import styles from './style.module.css';

/**
 * @typedef {import('../index').CardSize} CardSize
 * @typedef {import('Styles/colors').Color} Color
 * 
 * @typedef {object} CardValueProps
 * @property {React.JSX.Element|React.JSX.Element[]} children
 * @property {string} [title]
 * @property {CardSize} [size]
 * @property {Color} [color]
 * @property {string} [style]
 */

/**
 * @param {CardValueProps} props
 * @returns {React.JSX.Element}
 */
function CardElement({ children, title = '', style = '', size = '1/4', color = 'blue' }) {
    const sizeNb = `${size.replace('/', '')}`;

    return (
        <div
            className={`${styles.card} bg-${color} col-${sizeNb} ${style}`}
            style={{ paddingTop: !!title ? '52px' : '12px'}}
            data-title={title}
        >
            {children}
        </div>
    );
}

export default CardElement;
