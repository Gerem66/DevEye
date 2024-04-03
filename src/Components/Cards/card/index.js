import React from 'react';

import styles from './style.module.css';

/**
 * @typedef {import('Styles/colors').Color} Color
 * 
 * @typedef {object} CardValueProps
 * @property {React.JSX.Element|React.JSX.Element[]} children
 * @property {string} [title]
 * @property {'auto' | 'unset' | number} [width] The width of the card in percentage
 * @property {Color} [color]
 * @property {string} [style]
 */

/**
 * @param {CardValueProps} props
 * @returns {React.JSX.Element}
 */
function CardElement({ children, title = '', style = '', width = 'unset', color = 'blue' }) {
    return (
        <div
            className={`card-element ${styles.card} bg-${color} ${style}`}
            style={{
                paddingTop: !!title ? '52px' : '12px',
                maxWidth: width
            }}
            data-title={title}
        >
            {children}
        </div>
    );
}

export default CardElement;
