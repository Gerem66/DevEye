import React from 'react';

import styles from './style.module.css';

type SelectHTMLAttributes = import('react').SelectHTMLAttributes<HTMLSelectElement>;
type DetailedHTMLProps = import('react').DetailedHTMLProps<SelectHTMLAttributes, HTMLSelectElement>;
type SelectInputProps = DetailedHTMLProps;

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
