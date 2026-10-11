import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * La largeur réelle d'un élément, suivie par `ResizeObserver`. Le graphique se
 * dessine à cette largeur en pixels : un `viewBox` fixe étiré ferait varier le
 * corps des étiquettes avec la largeur, illisibles sur un téléphone.
 */
export function useElementWidth<T extends HTMLElement>(): [(node: T | null) => void, number] {
    const [width, setWidth] = useState(0);
    const observer = useRef<ResizeObserver | null>(null);

    // Une ref en callback : l'élément mesuré peut n'apparaître qu'après un chargement.
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
