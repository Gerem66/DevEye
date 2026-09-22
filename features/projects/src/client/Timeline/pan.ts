import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';

/**
 * Saisir la frise pour la faire défiler. Le geste ne part que du vide : partout
 * où une barre, un jalon ou un autre bouton réclame le pointeur, c'est son geste
 * qui compte, et non celui-ci.
 *
 * Pointer Events, comme le glissé de dates (`dateDrag.ts`) : l'application refuse
 * `draggable` partout (`client/src/nativeDrag.ts`). À la souris seulement, le
 * doigt ayant déjà le défilement natif de la boîte.
 */

/**
 * Ce qui tient son propre geste. Testé sur les ancêtres de la cible et non sur
 * elle seule : une barre porte un libellé et une pile d'avatars, c'est la barre
 * qu'on saisit en les visant.
 */
const OWN_GESTURE = 'button, a, input, select, textarea, summary, [role="switch"]';

/**
 * Le défilement de la frise, à raison d'une valeur par image : la fenêtre visible
 * s'en déduit, et c'est elle qui décide des lignes tenues et des jours écrits.
 * La fonction rendue le remet à jour sans attendre l'événement, pour qu'un
 * défilement posé à la main soit connu du rendu qui le pose.
 */
export function useScrollLeft(scrollRef: RefObject<HTMLElement | null>): [number, (px: number) => void] {
    const [scrollLeft, setScrollLeft] = useState(0);
    useEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        let frame = 0;
        const onScroll = () => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => setScrollLeft(el.scrollLeft));
        };
        setScrollLeft(el.scrollLeft);
        el.addEventListener('scroll', onScroll, { passive: true });
        return () => {
            cancelAnimationFrame(frame);
            el.removeEventListener('scroll', onScroll);
        };
    }, [scrollRef]);
    return [scrollLeft, setScrollLeft];
}

export interface TimelinePan {
    /** Un défilement est en cours : le curseur le dit, et rien ne doit le doubler. */
    panning: boolean;
    onPointerDown: (event: ReactPointerEvent) => void;
}

/**
 * @param scrollRef la boîte défilante de la frise, celle qu'on saisit.
 * @param enabled faux quand un autre geste tient déjà le pointeur.
 */
export function useTimelinePan(scrollRef: RefObject<HTMLElement | null>, enabled: boolean): TimelinePan {
    const [panning, setPanning] = useState(false);
    /** D'où le geste est parti : abscisse du pointeur et défilement de l'époque. */
    const from = useRef<{ x: number; scrollLeft: number } | null>(null);

    const onPointerDown = (event: ReactPointerEvent) => {
        const el = scrollRef.current;
        if (!enabled || !el || panning) return;
        // Bouton principal d'une souris : le doigt défile déjà tout seul, et le
        // bouton du milieu appartient au navigateur.
        if (event.pointerType !== 'mouse' || event.button !== 0) return;
        if (event.target instanceof Element && event.target.closest(OWN_GESTURE)) return;

        from.current = { x: event.clientX, scrollLeft: el.scrollLeft };
        setPanning(true);
        // La capture amène les événements suivants sur la boîte, même quand le
        // pointeur sort de la fenêtre en cours de geste.
        el.setPointerCapture(event.pointerId);
        // Sans quoi le navigateur sélectionne les étiquettes traversées.
        event.preventDefault();
    };

    useEffect(() => {
        const el = scrollRef.current;
        if (!panning || !el) return;
        const onMove = (event: PointerEvent) => {
            if (!from.current) return;
            // La frise suit le pointeur au pixel : c'est le contenu qu'on tient,
            // donc il va dans le sens inverse du défilement.
            el.scrollLeft = from.current.scrollLeft - (event.clientX - from.current.x);
        };
        const stop = () => {
            from.current = null;
            setPanning(false);
        };
        el.addEventListener('pointermove', onMove);
        el.addEventListener('pointerup', stop);
        el.addEventListener('pointercancel', stop);
        return () => {
            el.removeEventListener('pointermove', onMove);
            el.removeEventListener('pointerup', stop);
            el.removeEventListener('pointercancel', stop);
        };
    }, [panning, scrollRef]);

    return { panning, onPointerDown };
}
