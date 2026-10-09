import { useEffect, useRef, type ReactNode } from 'react';

import styles from './StickyHeader.module.css';

export interface StickyHeaderProps {
    /** La mise en page du bandeau quand il porte plus que l'en-tête (des onglets). */
    className?: string;
    children: ReactNode;
}

/** Le premier ancêtre qui défile : la popup, ou le dialogue qui héberge la vue. */
function scrollerOf(element: HTMLElement): Element | null {
    for (let node = element.parentElement; node; node = node.parentElement) {
        const overflow = getComputedStyle(node).overflowY;
        if (overflow === 'auto' || overflow === 'scroll') return node;
    }
    return null;
}

/**
 * Le bandeau du haut d'une vue : son en-tête, et la barre d'onglets qui le suit.
 * Il reste en haut du conteneur défilant pendant qu'on parcourt le contenu, et un
 * trait le sépare de ce qui passe dessous une fois collé.
 *
 * Sa hauteur est publiée en `--sticky-head` sur son parent : un second bandeau
 * collant du contenu se pose dessous par `top: var(--sticky-head, 0px)`. Ce
 * parent doit donc être la racine de la vue, qui est aussi la boîte dans laquelle
 * le bandeau colle.
 */
export function StickyHeader({ className, children }: StickyHeaderProps) {
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const band = ref.current;
        const parent = band?.parentElement;
        if (!band || !parent) return;

        const markStuck = (scroller: Element | null) => {
            const stuck =
                scroller !== null &&
                scroller.scrollTop > 0 &&
                Math.abs(band.getBoundingClientRect().top - scroller.getBoundingClientRect().top) < 1;
            band.toggleAttribute('data-stuck', stuck);
        };
        // La popup garde la vue montée d'une ouverture à l'autre, mais son
        // conteneur défilant est neuf à chaque fois : la réapparition du bandeau
        // le cherche de nouveau.
        const measure = () => {
            parent.style.setProperty('--sticky-head', `${band.offsetHeight}px`);
            markStuck(scrollerOf(band));
        };
        measure();

        const onScroll = (event: Event) => {
            if (event.target instanceof Element && event.target.contains(band)) markStuck(event.target);
        };
        // Un `scroll` ne remonte pas : seule la capture le voit passer au document.
        document.addEventListener('scroll', onScroll, { capture: true, passive: true });
        const observer = new ResizeObserver(measure);
        observer.observe(band);
        return () => {
            document.removeEventListener('scroll', onScroll, { capture: true });
            observer.disconnect();
            parent.style.removeProperty('--sticky-head');
        };
    }, []);

    return (
        <div ref={ref} className={className ? `${styles.band} ${className}` : styles.band}>
            {children}
        </div>
    );
}

export default StickyHeader;
