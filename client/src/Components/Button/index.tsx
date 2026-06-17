import type { ButtonHTMLAttributes, ReactNode } from 'react';
import styles from './style.module.css';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    /** Visual style. Defaults to the accent-filled primary button. */
    variant?: ButtonVariant;
    /** Optional leading icon name (see icons.css). */
    icon?: string;
    children?: ReactNode;
}

/** App-wide button. Use `variant` for intent; never hardcode colors. */
export default function Button({ variant = 'primary', icon, className, children, ...rest }: ButtonProps) {
    return (
        <button className={`${styles.button} ${styles[variant]} ${className ?? ''}`} {...rest}>
            {icon && <span className={`icon ${styles.icon} icon-${icon}`} />}
            {children}
        </button>
    );
}
