import React from 'react';

import styles from './style.module.css';

/**
 * @typedef {import('react').ButtonHTMLAttributes<HTMLButtonElement>} ButtonHTMLAttributes
 * @typedef {import('react').DetailedHTMLProps<ButtonHTMLAttributes, HTMLButtonElement>} DetailedHTMLProps
 * 
 * @typedef {DetailedHTMLProps & { color?: string }} ButtonProps
 */

/**
 * @param {ButtonProps} props
 * @returns {React.JSX.Element}
 */
function Button(props) {
    const { children, color, className, ...rest } = props;
    const classes = `${styles.button} ${className || ''}`;

    return (
        <button className={classes} {...rest}>
            <div
                className={styles['button-background']}
                style={{ backgroundColor: color || '#4481dd' }}
            />
            {children}
        </button>
    );
}

export default Button;
