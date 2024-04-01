import React from 'react';

import styles from './style.module.css';

/**
 * @typedef {import('react').InputHTMLAttributes<HTMLInputElement>} InputHTMLAttributes
 * @typedef {import('react').DetailedHTMLProps<InputHTMLAttributes, HTMLInputElement>} DetailedHTMLProps
 */

/**
 * @typedef {DetailedHTMLProps} TextInputProps
 */

/**
 * @type {React.ForwardRefExoticComponent<TextInputProps>}
 */
const TextInput = React.forwardRef((props, ref) => {
    const classes = `${styles.input} ${props.className || ''}`;

    return (
        <input
            ref={ref}
            type='text'
            className={classes}
            {...props}
        />
    );
});

export default TextInput;
