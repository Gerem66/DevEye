import React from 'react';

import styles from './style.module.css';

type ButtonHTMLAttributes = import('react').ButtonHTMLAttributes<HTMLButtonElement>;
type DetailedHTMLProps = import('react').DetailedHTMLProps<ButtonHTMLAttributes, HTMLButtonElement>;
type ButtonProps = DetailedHTMLProps & { color?: string; };

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
