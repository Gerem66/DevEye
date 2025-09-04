import React from 'react';

import styles from './style.module.css';

import type { ButtonHTMLAttributes, DetailedHTMLProps } from 'react';

type ButtonAttributes = ButtonHTMLAttributes<HTMLButtonElement>;
type DetailedButtonProps = DetailedHTMLProps<ButtonAttributes, HTMLButtonElement>;
type ButtonProps = DetailedButtonProps & { color?: string };

function Button(props: ButtonProps): React.JSX.Element {
    const { children, color, className, ...rest } = props;
    const classes = `${styles.button} ${className || ''}`;

    return (
        <button className={classes} {...rest}>
            <div className={styles['button-background']} style={{ backgroundColor: color || '#4481dd' }} />
            {children}
        </button>
    );
}

export default Button;
