import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react';
import styles from './style.module.css';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    /** Visual style. Defaults to the accent-filled primary button. */
    variant?: ButtonVariant;
    /** Optional leading icon name (see icons.css). */
    icon?: string;
    children?: ReactNode;
    /**
     * Un vrai lien à l'allure du bouton : le navigateur l'ouvre, le copie ou
     * le met en onglet lui-même. `_blank` reçoit son `rel` de sûreté.
     */
    href?: string;
    target?: string;
    rel?: string;
}

/** App-wide button. Use `variant` for intent; never hardcode colors. */
export default function Button({
    variant = 'primary',
    icon,
    className,
    children,
    href,
    target,
    rel,
    ...rest
}: ButtonProps) {
    const classes = `${styles.button} ${styles[variant]} ${className ?? ''}`;
    const content = (
        <>
            {icon && <span className={`icon ${styles.icon} icon-${icon}`} />}
            {children}
        </>
    );
    if (href !== undefined) {
        return (
            <a
                className={classes}
                href={href}
                target={target}
                rel={rel ?? (target === '_blank' ? 'noopener noreferrer' : undefined)}
                {...(rest as unknown as AnchorHTMLAttributes<HTMLAnchorElement>)}
            >
                {content}
            </a>
        );
    }
    return (
        <button className={classes} {...rest}>
            {content}
        </button>
    );
}
