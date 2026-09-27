import { useContext, useEffect } from 'react';

import { addSubView, setOverlayView, setRootView } from './views';
import { ViewScopeContext } from './ViewScope';

/** La vue ouverte : posée par l'accueil et par les pages d'avant la connexion. `null` ne pose rien. */
export function useRootView(id: string | null): void {
    useEffect(() => {
        if (id === null) return;
        setRootView(id);
        return () => setRootView(null);
    }, [id]);
}

/** Une fenêtre par-dessus la vue (la coquille de réglages) ; `null` quand elle se ferme. */
export function useOverlayView(path: string | null): void {
    useEffect(() => {
        setOverlayView(path);
        return () => setOverlayView(null);
    }, [path]);
}

/**
 * L'écran d'une feature à l'intérieur de sa vue, en segments statiques
 * (`'history'`, `'site/traffic'`), jamais un identifiant ni un nom. Compté
 * seulement quand sa vue est celle ouverte ; `null` le retire.
 */
export function useSubView(segment: string | null): void {
    const scope = useContext(ViewScopeContext);
    useEffect(() => {
        if (!segment || !scope) return;
        return addSubView(scope, segment);
    }, [scope, segment]);
}
