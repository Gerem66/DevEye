import type { UserColor } from '@deveye/types';
import { useEffect, useMemo, useReducer, type CSSProperties } from 'react';

import { userColorVar } from '@/Features/Profile/userColors';
import { useLivePresence, type LiveSegmentKind } from '@/stores/live';
import { divergingSegment } from './paths';

/**
 * Entoure un nœud de la couleur de qui s'y trouve. Dans une liste, un hook par
 * ligne est impossible : {@link useLiveOutlines} rend alors une fonction de
 * consultation, appelée autant de fois qu'il y a de lignes. La règle elle-même,
 * quel nœud désigner pour un pair donné, vit dans `paths.ts`.
 *
 * Plusieurs occupants ne se partagent pas la bordure : une seule couleur à la
 * fois, qui alterne toutes les trois secondes avec un fondu (`Styles/live.css`).
 * L'alternance suit un compteur unique partagé par toute l'application, pour que
 * tous les nœuds changent de teinte ensemble et non en ordre dispersé.
 */

const ROTATE_MS = 3000;

let tick = 0;
let timer: ReturnType<typeof setInterval> | null = null;
const tickListeners = new Set<() => void>();

function subscribeTick(fn: () => void): () => void {
    tickListeners.add(fn);
    if (timer === null) {
        timer = setInterval(() => {
            tick += 1;
            for (const l of tickListeners) l();
        }, ROTATE_MS);
    }
    return () => {
        tickListeners.delete(fn);
        if (tickListeners.size === 0 && timer !== null) {
            clearInterval(timer);
            timer = null;
        }
    };
}

/** Propriétés à étaler sur l'élément à entourer. */
export interface LiveOutlineProps {
    'data-live-peer'?: true;
    style?: CSSProperties;
}

/**
 * Forme liste : rend une fonction qui donne les propriétés d'un nœud de ce niveau,
 * à appeler dans un `map`. Le travail est fait une fois pour tous les pairs, quel
 * que soit le nombre de lignes.
 */
export function useLiveOutlines(kind: LiveSegmentKind): (value: string | null) => LiveOutlineProps {
    // Vue étroite : les contours ne dépendent pas des curseurs, et ne doivent pas
    // se redessiner vingt fois par seconde parce qu'un pair bouge.
    const { peers, path } = useLivePresence();
    const [, bump] = useReducer((n: number) => n + 1, 0);

    const byValue = useMemo(() => {
        const prefix = `${kind}:`;
        const map = new Map<string, UserColor[]>();
        for (const peer of peers) {
            const segment = divergingSegment(path, peer.path);
            if (segment === null || !segment.startsWith(prefix)) continue;
            const value = segment.slice(prefix.length);
            const colors = map.get(value);
            if (colors) {
                if (!colors.includes(peer.color)) colors.push(peer.color);
            } else {
                map.set(value, [peer.color]);
            }
        }
        // Trié : sans quoi la couleur affichée sauterait au gré de l'ordre du roster.
        for (const colors of map.values()) colors.sort();
        return map;
    }, [peers, path, kind]);

    // L'abonnement au compteur n'existe que tant qu'il y a de quoi alterner.
    const rotating = useMemo(() => [...byValue.values()].some((c) => c.length > 1), [byValue]);
    useEffect(() => {
        if (!rotating) return;
        return subscribeTick(bump);
    }, [rotating]);

    return (value) => {
        if (value === null) return {};
        const colors = byValue.get(value);
        if (!colors || colors.length === 0) return {};
        return {
            'data-live-peer': true,
            style: { '--live-peer': userColorVar(colors[tick % colors.length]) } as CSSProperties
        };
    };
}

/** Forme unitaire, pour un composant qui ne représente qu'un seul nœud. */
export function useLiveOutline(kind: LiveSegmentKind, value: string | null): LiveOutlineProps {
    return useLiveOutlines(kind)(value);
}
