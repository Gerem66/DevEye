import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * La largeur réelle d'un élément, suivie par `ResizeObserver`.
 *
 * Le graphe des commits dessine des disques : un `viewBox` fixe étiré par
 * `preserveAspectRatio='none'` les rendrait elliptiques et ferait varier le corps
 * des étiquettes avec la largeur. D'où la mesure en pixels réels.
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
