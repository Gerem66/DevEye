import { createContext, useContext } from 'react';

/**
 * Le pied de la coquille de réglages : là où va le bouton qui enregistre tout
 * l'onglet, épinglé en bas à droite du dialogue, hors de ce qui défile.
 *
 * `undefined` : aucune coquille autour, le bouton reste dans son panneau.
 * `null` : la coquille est là, son pied n'est pas encore monté ; le bouton
 * attend un rendu plutôt que d'apparaître un instant à l'ancienne place.
 */
export const SettingsFooterContext = createContext<HTMLElement | null | undefined>(undefined);

export function useSettingsFooter(): HTMLElement | null | undefined {
    return useContext(SettingsFooterContext);
}
