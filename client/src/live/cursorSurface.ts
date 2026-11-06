import { useContext, useEffect, useSyncExternalStore } from 'react';

import { ViewScopeContext } from '@/telemetry/ViewScope';

/**
 * Où les curseurs se placent : la popup (ou l'accueil), ou la surface qu'une
 * vue déclare, un canevas qu'on déplace et qu'on zoome, où un point rapporté à
 * la popup ne désigne rien. Le même mécanisme dans les deux cas ; seuls le
 * repère et les pairs changent : ceux du même chemin pour la popup, ceux du
 * canal de la vue pour la sienne.
 */
export interface LiveCursorSurface {
    /** Le canal où le serveur du module a assis la connexion. */
    channel: string;
    fromScreen(clientX: number, clientY: number): { x: number; y: number } | null;
    toScreen(x: number, y: number): { x: number; y: number } | null;
    subscribe(onChange: () => void): () => void;
}

/** La surface en vigueur : `channel` à `null` pour la popup. */
export type CursorSurface = Omit<LiveCursorSurface, 'channel'> & { channel: string | null };

/**
 * La popup : `x` relatif à sa largeur, `y` en pixels du contenu (voir
 * `liveCursorSchema`). Sa géométrie se lit à chaque appel, jamais en cache : le
 * morphe d'ouverture anime un `transform` qu'aucun observateur ne voit passer.
 */
export function popupSurface(el: HTMLElement): CursorSurface {
    return {
        channel: null,
        fromScreen(clientX, clientY) {
            const rect = el.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return null;
            return { x: (clientX - rect.left) / rect.width, y: clientY - rect.top + el.scrollTop };
        },
        toScreen(x, y) {
            const rect = el.getBoundingClientRect();
            return { x: rect.left + x * rect.width, y: rect.top + y - el.scrollTop };
        },
        subscribe(onChange) {
            const observer = new ResizeObserver(onChange);
            observer.observe(el);
            // En capture, sur le document : le repère de l'accueil ne défile pas
            // lui-même, c'est son parent qui bouge.
            document.addEventListener('scroll', onChange, { passive: true, capture: true });
            window.addEventListener('resize', onChange);
            return () => {
                observer.disconnect();
                document.removeEventListener('scroll', onChange, { capture: true });
                window.removeEventListener('resize', onChange);
            };
        }
    };
}

/**
 * Les surfaces déclarées, une par vue. Rangées par vue et non empilées : une
 * vue gardée montée derrière une popup fermée (`FeatureKeepAlive`) ne doit pas
 * retenir les curseurs sur un canevas que personne ne voit.
 */
const declared = new Map<string, LiveCursorSurface>();
const listeners = new Set<() => void>();

function notify(): void {
    for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** Place les curseurs sur `surface` tant que la vue qui l'appelle est celle qui est ouverte. */
export function useLiveCursorSurface(surface: LiveCursorSurface | null): void {
    const view = useContext(ViewScopeContext);
    useEffect(() => {
        if (surface === null || view === null) return;
        declared.set(view, surface);
        notify();
        return () => {
            if (declared.get(view) !== surface) return;
            declared.delete(view);
            notify();
        };
    }, [view, surface]);
}

/** La surface qu'a déclarée la vue `view`, ou `null`. */
export function useDeclaredSurface(view: string | null): LiveCursorSurface | null {
    return useSyncExternalStore(
        subscribe,
        () => (view === null ? null : (declared.get(view) ?? null)),
        () => null
    );
}
