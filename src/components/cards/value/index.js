import React from 'react';

import './style.css';
import CardElement from '../card';

/**
 * @typedef {import('../index').CardSize} CardSize
 * @typedef {import('../index').CardColor} CardColor
 * @typedef {import('../../../styles/icons').Icon} Icon
 * 
 * @typedef {object} CardValueProps
 * @property {string} title
 * @property {string} value
 * @property {Icon|null} [icon]
 * @property {CardSize} [size]
 * @property {CardColor} [color]
 */

/**
 * @param {CardValueProps} props
 * @returns {React.JSX.Element}
 */
function CardValue({ title, value, icon = null, size = '1/4', color = 'blue' }) {
    return (
        <CardElement size={size} color={color}>
            <p className='title'>{title}</p>
            <p className='value'>{value}</p>
            {icon !== null && (
                <div className='icon-container'>
                    <i className={`icon icon-${icon}`} />
                </div>
            )}
        </CardElement>
    );
}

export default CardValue;