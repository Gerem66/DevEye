import React from 'react';

import styles from './style.module.css';

/**
 * @typedef {import('react').SelectHTMLAttributes<HTMLSelectElement>} SelectHTMLAttributes
 * @typedef {import('react').DetailedHTMLProps<SelectHTMLAttributes, HTMLSelectElement>} DetailedHTMLProps
 */

/**
 * @typedef {DetailedHTMLProps} SelectInputProps
 */

/**
 * @type {React.ForwardRefExoticComponent<SelectInputProps>}
 */
const SelectInput = React.forwardRef((props, ref) => {
    const classes = `${styles.input} ${props.className || ''}`;

    return (
        <select
            ref={ref}
            {...props}
            className={classes}
        >
            {props.children}
        </select>
    );
});

export default SelectInput;
