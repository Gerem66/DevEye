import { useCallback, useEffect, useRef, useState } from 'react';

import Button from '@/Components/Button';

/**
 * Le bouton d'enregistrement d'un panneau de réglages.
 *
 * Tout le retour tient dans le bouton : « Enregistrement… » pendant l'aller-
 * retour, « Enregistré » quelques secondes après, puis l'intitulé de départ. Un
 * message posé à côté déplaçait la rangée au moment précis où l'œil y revenait,
 * et chaque panneau réinventait le sien. Les erreurs, elles, restent au panneau :
 * elles ont besoin de place et ne s'effacent pas toutes seules.
 */

/** Combien de temps le bouton garde « Enregistré » avant de reprendre son intitulé. */
const SAVED_MS = 2500;

interface SaveButtonProps {
    /** L'enregistrement. Une promesse rejetée laisse le bouton reprendre son intitulé. */
    onSave: () => Promise<unknown> | unknown;
    /** L'intitulé au repos. */
    children?: string;
    /** Empêche l'enregistrement (formulaire vide, rien à changer). */
    disabled?: boolean;
    variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
    icon?: string;
    title?: string;
}

export default function SaveButton({
    onSave,
    children = 'Enregistrer',
    disabled,
    variant,
    icon,
    title
}: SaveButtonProps) {
    const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle');
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    // Un panneau démonté pendant l'aller-retour ne doit pas rendre la main sur
    // un composant parti (le dialogue se referme sur l'enregistrement).
    const alive = useRef(true);

    useEffect(() => {
        alive.current = true;
        return () => {
            alive.current = false;
            if (timer.current) clearTimeout(timer.current);
        };
    }, []);

    const click = useCallback(async () => {
        if (state === 'saving') return;
        // Un second enregistrement pendant que « Enregistré » s'affiche repart
        // proprement : l'ancienne échéance ne doit pas couper la nouvelle.
        if (timer.current) clearTimeout(timer.current);
        setState('saving');
        try {
            await onSave();
            if (!alive.current) return;
            setState('saved');
            timer.current = setTimeout(() => {
                if (alive.current) setState('idle');
            }, SAVED_MS);
        } catch {
            // Le panneau dit pourquoi ; le bouton se contente de redevenir cliquable.
            if (alive.current) setState('idle');
        }
    }, [onSave, state]);

    return (
        <Button
            onClick={() => void click()}
            disabled={disabled || state === 'saving'}
            variant={variant}
            icon={icon}
            title={title}
        >
            {state === 'saving' ? 'Enregistrement…' : state === 'saved' ? 'Enregistré' : children}
        </Button>
    );
}
