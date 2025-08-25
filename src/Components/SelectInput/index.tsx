import React from 'react';

import styles from './style.module.css';

import type { SelectHTMLAttributes, DetailedHTMLProps } from 'react';

type SelectInputProps = DetailedHTMLProps<SelectHTMLAttributes<HTMLSelectElement>, HTMLSelectElement>;

const SelectInput = React.forwardRef<HTMLSelectElement, SelectInputProps>((props, ref) => {
    const classes = `${styles.input} ${props.className || ''}`;

    return (
        <select ref={ref} {...props} className={classes}>
            {props.children}
        </select>
    );
});

SelectInput.displayName = 'SelectInput';

export default SelectInput;
