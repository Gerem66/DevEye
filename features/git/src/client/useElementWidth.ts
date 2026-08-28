import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * La largeur réelle d'un élément, suivie par `ResizeObserver`.
 *
 * Le reste du dépôt dessine ses graphes dans un `viewBox` fixe étiré par
 * `preserveAspectRatio='none'` (`features/uptime/src/client/UptimeChart.tsx`,
 * `Features/Monitoring/MiniGraph.tsx`). C'est parfait pour une courbe : un trait
 * étiré reste un trait. Ça ne l'est pas ici, où l'on dessine des **disques** —
 * l'étirement les transforme en ellipses, et l'étiquette d'axe change de corps
 * avec la largeur de la fenêtre.
 *
 * D'où la mesure : le graphe des commits travaille en pixels réels. C'est la
 * seule chose que le `viewBox` ne sait pas faire.
 *
 * `ResizeObserver` est une primitive du navigateur — aucune dépendance ajoutée.
 */
export function useElementWidth<T extends HTMLElement>(): [(node: T | null) => void, number] {
    const [width, setWidth] = useState(0);
    const observer = useRef<ResizeObserver | null>(null);

    // Callback ref plutôt que `useRef` + `useEffect` : l'élément mesuré peut
    // apparaître après un chargement, et une ref muette ne préviendrait personne.
    const ref = useCallback((node: T | null) => {
        observer.current?.disconnect();
        observer.current = null;
        if (!node) return;
        setWidth(node.clientWidth);
        const ro = new ResizeObserver((entries) => {
            const entry = entries[0];
            if (entry) setWidth(Math.round(entry.contentRect.width));
        });
        ro.observe(node);
        observer.current = ro;
    }, []);

    useEffect(() => () => observer.current?.disconnect(), []);

    return [ref, width];
}
