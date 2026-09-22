import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import Button from '@/Components/Button';

import { useSettingsFooter } from './footer';

/**
 * Le bouton d'enregistrement d'un panneau de réglages.
 *
 * Tout le retour tient dans le bouton : « Enregistrement… » pendant l'aller-
 * retour, « Enregistré » quelques secondes après, puis l'intitulé de départ. Un
 * message posé à côté déplaçait la rangée au moment précis où l'œil y revenait,
 * et chaque panneau réinventait le sien. Les erreurs, elles, restent au panneau :
 * elles ont besoin de place et ne s'effacent pas toutes seules.
 *
 * Sa place dépend de ce qu'il enregistre. Tout l'onglet : le pied du dialogue,
 * en bas à droite, hors de ce qui défile, sans quoi il finit sous le contenu,
 * hors de vue dès qu'il y a un ascenseur. Une partie seulement (un bloc, un
 * élément d'une liste) : dans le panneau, à côté de ce qu'il concerne. Le portail
 * ne déplace que le DOM : le bouton garde son arbre React, donc son `onSave`.
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
    /**
     * `footer` (défaut) : le pied du dialogue de réglages, pour un bouton qui
     * enregistre tout l'onglet. `inline` : là où il est écrit, pour un bouton qui
     * n'enregistre qu'une partie. Hors coquille, tout est inline.
     */
    placement?: 'footer' | 'inline';
}

export default function SaveButton({
    onSave,
    children = 'Enregistrer',
    disabled,
    variant,
    icon,
    title,
    placement = 'footer'
}: SaveButtonProps) {
    const footer = useSettingsFooter();
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

    const button = (
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

    if (placement === 'inline' || footer === undefined) return button;
    // La coquille est là mais son pied pas encore monté : un rendu d'attente
    // plutôt qu'un bouton qui apparaît en bas du panneau puis saute.
    if (footer === null) return null;
    return createPortal(button, footer);
}
