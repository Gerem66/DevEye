import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';

/**
 * De combien un second bandeau collant doit descendre pour se poser sous le
 * premier. Deux bandeaux `position: sticky` à `top: 0` se recouvrent, et la
 * hauteur du premier ne se devine pas : elle change avec le contenu, la largeur
 * de la fenêtre et les retours à la ligne d'une barre d'onglets.
 *
 * Elle est donc mesurée et publiée dans `--sticky-head`, que le bandeau du
 * dessous lit avec un repli à `0px` : il n'a rien à savoir de son voisin, et se
 * comporte correctement là où il n'y en a pas.
 *
 * `ResizeObserver` convient ici, contrairement au cas des curseurs de présence :
 * on mesure la hauteur propre d'un bandeau, qui ne varie que par la mise en page,
 * et non une boîte que seul un `transform` animé déplace.
 */
export interface StickyOffset<T extends HTMLElement> {
    /** À poser sur le bandeau **du haut**, celui dont on mesure la hauteur. */
    ref: RefObject<T | null>;
    /** À poser sur un ancêtre commun aux deux bandeaux. */
    style: CSSProperties;
}

export function useStickyOffset<T extends HTMLElement>(): StickyOffset<T> {
    const ref = useRef<T | null>(null);
    const [height, setHeight] = useState(0);

    useEffect(() => {
        const element = ref.current;
        if (!element) return;

        const measure = () => setHeight(element.offsetHeight);
        measure();

        // `offsetHeight` plutôt que `contentRect` : c'est la place réellement
        // occupée, rembourrage et bordures compris, dont le bandeau du dessous doit
        // descendre.
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    return { ref, style: { '--sticky-head': `${height}px` } as CSSProperties };
}
