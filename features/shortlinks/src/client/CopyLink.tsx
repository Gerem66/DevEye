import { Button, copyText } from 'deveye-sdk-client';
import { useEffect, useRef, useState } from 'react';

const FEEDBACK_MS = 2000;

/**
 * Copier l'adresse d'un lien, confirmé sur le bouton. `copyText` du SDK : le
 * presse-papiers du navigateur n'existe qu'en contexte sécurisé, et son refus
 * se dit plutôt que de laisser croire à une copie.
 */
export default function CopyLink({ url, variant = 'secondary' }: { url: string; variant?: 'secondary' | 'ghost' }) {
    const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(
        () => () => {
            if (timer.current) clearTimeout(timer.current);
        },
        []
    );

    const copy = async (): Promise<void> => {
        setState((await copyText(url)) ? 'done' : 'failed');
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setState('idle'), FEEDBACK_MS);
    };

    return (
        <Button
            variant={variant}
            icon={state === 'done' ? 'square-check' : 'copy'}
            title={`Copier ${url}`}
            aria-live='polite'
            onClick={() => void copy()}
        >
            {state === 'done' ? 'Copié' : state === 'failed' ? 'À copier à la main' : 'Copier'}
        </Button>
    );
}
