import { LIVE_CURSOR_COMMAND, type LiveCursor } from 'deveye-types';
import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';

import { ws } from '@/api/ws';
import { refreshLive } from '@/stores/live';
import { cursorKindAt } from './cursorKind';
import { useWorkspaceState } from '@/stores/workspace';

/**
 * Le cycle de vie de la présence, et la **surface** des curseurs.
 *
 * ## La surface
 *
 * Les coordonnées d'un curseur n'ont de sens que rapportées à un cadre commun.
 * Ce cadre ne peut pas être un nœud appartenant à une feature :
 * `FeatureKeepAlive` déplace physiquement le conteneur d'une feature entre le
 * corps de la popup et un support caché, et `WidgetPopup` recrée son élément de
 * défilement à chaque ouverture — aucune identité ne survit.
 *
 * La surface est donc **le corps de la popup**, que l'accueil détient déjà dans
 * son état, ou **la zone de contenu de l'accueil** quand rien n'est ouvert. Comme
 * deux pairs n'échangent de curseurs que s'ils sont au **même chemin**, ils ont
 * forcément la même surface logique : le cas « feature garée dans un support
 * `display: none` » ne peut pas se produire.
 *
 * ## Les unités
 *
 * `x` relatif à la largeur, `y` en pixels absolus du contenu — voir
 * `liveCursorSchema` dans deveye-types pour le pourquoi de ce mélange.
 */

const SurfaceContext = createContext<HTMLElement | null>(null);

/** La surface courante, pour replacer les curseurs reçus. */
export function useLiveSurface(): HTMLElement | null {
    return useContext(SurfaceContext);
}

/** Plancher d'émission. Au-delà de ~20 Hz, l'œil ne gagne plus rien. */
const EMIT_FLOOR_MS = 50;

export function LiveProvider({ surface, children }: { surface: HTMLElement | null; children: ReactNode }) {
    const { epoch } = useWorkspaceState();

    useEffect(() => {
        // La reconnexion est prise en charge par le store lui-même ; ce qu'il ne
        // peut pas voir sans dépendre de React, c'est la bascule d'espace — d'où
        // cette époque, la même qui sert déjà de clé de remontage aux features.
        refreshLive();
    }, [epoch]);

    const lastSentAt = useRef(0);
    const frame = useRef<number | null>(null);
    /**
     * Le dernier point vu, **brut**. Rien n'est calculé ici : `pointermove` peut
     * dépasser la centaine d'événements par seconde, alors qu'on n'en émet que
     * vingt. La conversion et surtout la lecture du curseur effectif — qui
     * interroge la mise en page — attendent la vidange.
     */
    const lastPoint = useRef<{ x: number; y: number; buttons: number } | null>(null);
    const hadCursor = useRef(false);

    useEffect(() => {
        if (!surface) return;

        const flush = (): void => {
            frame.current = null;
            lastSentAt.current = Date.now();

            const point = lastPoint.current;
            let cursor: LiveCursor | null = null;
            if (point) {
                const rect = surface.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) {
                    // Les coordonnées peuvent sortir de la surface — marges de la
                    // popup, bords de l'écran — et c'est voulu : on est toujours
                    // sur la même page, le curseur doit continuer d'exister.
                    cursor = {
                        x: (point.x - rect.left) / rect.width,
                        y: point.y - rect.top + surface.scrollTop,
                        kind: cursorKindAt(point.x, point.y, (point.buttons & 1) !== 0)
                    };
                }
            }
            hadCursor.current = cursor !== null;
            ws.post(LIVE_CURSOR_COMMAND, { cursor });
        };

        const schedule = (): void => {
            if (frame.current !== null) return;
            const wait = Math.max(0, EMIT_FLOOR_MS - (Date.now() - lastSentAt.current));
            frame.current = window.setTimeout(() => requestAnimationFrame(flush), wait);
        };

        const onMove = (e: PointerEvent): void => {
            // Souris seulement : un doigt n'a pas de position au repos, et un
            // curseur qui se fige là où quelqu'un a tapé se lit comme une
            // présence qui n'existe plus.
            if (e.pointerType !== 'mouse') return;
            lastPoint.current = { x: e.clientX, y: e.clientY, buttons: e.buttons };
            schedule();
        };

        const clear = (): void => {
            if (!hadCursor.current) return;
            lastPoint.current = null;
            schedule();
        };

        window.addEventListener('pointermove', onMove, { passive: true });
        // Effacé quand le pointeur quitte la **fenêtre**, jamais la surface : le
        // faire sur la surface était ce qui donnait l'impression que le curseur
        // d'un pair « disparaissait sur les côtés » alors qu'il était encore là,
        // simplement dans la marge de la popup.
        document.documentElement.addEventListener('pointerleave', clear);
        // Un onglet caché ne doit pas laisser un curseur immobile chez les autres.
        document.addEventListener('visibilitychange', clear);

        return () => {
            window.removeEventListener('pointermove', onMove);
            document.documentElement.removeEventListener('pointerleave', clear);
            document.removeEventListener('visibilitychange', clear);
            if (frame.current !== null) clearTimeout(frame.current);
            frame.current = null;
            if (hadCursor.current) ws.post(LIVE_CURSOR_COMMAND, { cursor: null });
            hadCursor.current = false;
        };
    }, [surface]);

    return <SurfaceContext.Provider value={surface}>{children}</SurfaceContext.Provider>;
}
