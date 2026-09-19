import { useEffect, useRef, useState } from 'react';

import styles from './style.module.css';

export interface CopyButtonProps {
    value: string;
    /** Ce qui est copié, pour l'infobulle et les lecteurs d'écran (« Copier la clé »). */
    label?: string;
    className?: string;
}

const FEEDBACK_MS = 2000;

/** Copie `value` dans le presse-papiers, et le confirme deux secondes par son icône. */
export default function CopyButton({ value, label = 'Copier', className }: CopyButtonProps) {
    const [copied, setCopied] = useState(false);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(
        () => () => {
            if (timer.current) clearTimeout(timer.current);
        },
        []
    );

    const copy = () => {
        // Un presse-papiers refusé (contexte non sécurisé, permission) reste muet.
        navigator.clipboard.writeText(value).then(
            () => {
                setCopied(true);
                if (timer.current) clearTimeout(timer.current);
                timer.current = setTimeout(() => setCopied(false), FEEDBACK_MS);
            },
            () => undefined
        );
    };

    return (
        <button
            type='button'
            className={`${styles.copy} ${copied ? styles.copied : ''} ${className ?? ''}`}
            title={copied ? 'Copié !' : label}
            aria-label={copied ? 'Copié' : label}
            onClick={copy}
        >
            <i className={`icon ${copied ? 'icon-square-check' : 'icon-copy'}`} aria-hidden='true' />
        </button>
    );
}
