import React from 'react';

import styles from './style.module.css';

/**
 * @typedef {import('react').ButtonHTMLAttributes<HTMLButtonElement>} ButtonHTMLAttributes
 * @typedef {import('react').DetailedHTMLProps<ButtonHTMLAttributes, HTMLButtonElement>} DetailedHTMLProps
 * 
 * @typedef {object} CardValueProps
 * @property {React.JSX.Element|React.JSX.Element[]} children
 * @property {string} [title]
 * @property {string} [style]
 */

/**
 * @param {DetailedHTMLProps} props
 * @returns {React.JSX.Element}
 */
function Button(props) {
    const { children } = props;
    const classes = `${styles.button} ${props.className || ''}`;

    return (
        <button {...props} className={classes}>
            {children}
        </button>
    );
}

export default Button;
