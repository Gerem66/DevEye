import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';

/**
 * De combien un second bandeau collant doit descendre pour se poser sous le
 * premier.
 *
 * Deux bandeaux `position: sticky` déclarés à `top: 0` se recouvrent : le
 * second glisse sous le premier et disparaît. Il faut donc décaler le second de
 * la hauteur du premier, et cette hauteur ne se devine pas. Elle change avec le
 * contenu, avec la largeur de la fenêtre, et avec les retours à la ligne d'une
 * barre d'onglets.
 *
 * Ce petit crochet la **mesure** et la publie dans `--sticky-head`, que le
 * bandeau du dessous lit avec un repli à `0px`. Deux conséquences agréables :
 * le bandeau du dessous n'a rien à savoir de son voisin, et il se comporte
 * correctement là où il n'y en a pas — c'est le cas de la fiche d'un site vue
 * depuis la feature Audience, où il colle simplement en haut.
 *
 * ⚠️ **`ResizeObserver` convient ici, contrairement au cas des curseurs de
 * présence.** Ce qui l'avait rendu inutilisable là-bas était le morphe
 * d'ouverture d'une popup, qui anime un `transform` : celui-ci ne change pas la
 * boîte de bordure et ne déclenche donc aucune notification. Ici on mesure la
 * hauteur propre d'un bandeau, qui ne varie que par la mise en page, ce que
 * l'observateur voit toujours.
 *
 * ```tsx
 * const sticky = useStickyOffset<HTMLDivElement>();
 * <div className={styles.root} style={sticky.style}>
 *     <div ref={sticky.ref} className={styles.head}>…</div>
 * </div>
 * ```
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

        // `offsetHeight` plutôt que `contentRect` : ce qu'on veut est la place
        // réellement occupée, rembourrage et bordures compris, puisque c'est de
        // cette hauteur-là que le bandeau du dessous doit descendre.
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    return { ref, style: { '--sticky-head': `${height}px` } as CSSProperties };
}
