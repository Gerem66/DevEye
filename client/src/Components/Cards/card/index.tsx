import React from 'react';

import styles from './style.module.css';

import type Color from '@/Styles/colors.css';

interface CardValueProps {
    children: React.JSX.Element | React.JSX.Element[];
    title?: string;
    width?: 'auto' | 'unset' | number;
    color?: keyof typeof Color;
    style?: string;
}

function CardElement({
    children,
    title = '',
    style = '',
    width = 'unset',
    color = 'bg-blue'
}: CardValueProps): React.JSX.Element {
    return (
        <div
            className={`card-element ${styles.card} ${color} ${style}`}
            style={{
                paddingTop: title ? '52px' : '12px',
                maxWidth: width
            }}
            data-title={title}
        >
            {children}
        </div>
    );
}

export default CardElement;
