import type { MouseEvent, ReactNode } from 'react';

interface TextLinkProps {
    href: string;
    /** Rangé derrière la carte quand faux (voir `.text-link` dans `style.css`). */
    shown: boolean;
    /** La navigation interne, sans rechargement. */
    onNavigate: () => void;
    children: ReactNode;
}

/**
 * Le lien sous la carte (connexion <-> inscription). Un vrai lien : son adresse
 * se lit au survol, s'ouvre dans un nouvel onglet, se copie. Seul le clic simple
 * est repris par l'app ; tout clic modifié suit l'adresse comme d'habitude.
 */
export function TextLink({ href, shown, onNavigate, children }: TextLinkProps) {
    const onClick = (e: MouseEvent<HTMLAnchorElement>): void => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        onNavigate();
    };
    return (
        <a
            href={href}
            className={'text-link' + (shown ? ' shown' : '')}
            onClick={onClick}
            tabIndex={shown ? 0 : -1}
            aria-hidden={!shown}
        >
            {children}
        </a>
    );
}
