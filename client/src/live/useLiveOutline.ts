import type { UserColor } from 'deveye-types';
import { useEffect, useMemo, useState, type CSSProperties } from 'react';

import { userColorVar } from '@/Features/Profile/userColors';
import { useLive, type LiveSegmentKind } from '@/stores/live';

/**
 * Entoure un nœud de la couleur de qui s'y trouve, **plus bas que moi**.
 *
 * C'est la seconde moitié du moteur, et elle tient en un appel :
 *
 * ```tsx
 * <div className={styles.accountCard} {...useLiveOutline('account', String(account.id))}>
 * ```
 *
 * La règle, appliquée ici une fois pour toutes : un pair dont le chemin
 * **commence par le mien** et va plus loin est signalé sur le segment situé juste
 * en dessous de moi. Deux chemins identiques n'entourent rien — à ce moment-là on
 * se voit par les curseurs. Deux chemins divergents non plus.
 *
 * ## Plusieurs occupants
 *
 * Pas de demi-bordures : une seule couleur à la fois, qui **alterne toutes les
 * trois secondes** avec un fondu (la transition vit dans `Styles/live.css`).
 * L'alternance est pilotée par un compteur unique partagé par toute
 * l'application — un `setInterval` au total, pas un par élément entouré, et tous
 * les nœuds changent donc de teinte en même temps plutôt qu'en ordre dispersé.
 */

const ROTATE_MS = 3000;

let tick = 0;
let timer: ReturnType<typeof setInterval> | null = null;
const tickListeners = new Set<(n: number) => void>();

function subscribeTick(fn: (n: number) => void): () => void {
    tickListeners.add(fn);
    if (timer === null) {
        timer = setInterval(() => {
            tick += 1;
            for (const l of tickListeners) l(tick);
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

export function useLiveOutline(kind: LiveSegmentKind, value: string | null): LiveOutlineProps {
    const { peers, path } = useLive();
    const [, setTick] = useState(0);

    const colors = useMemo(() => {
        if (value === null) return [];
        const segment = `${kind}:${value}`;
        const found = new Set<UserColor>();
        for (const peer of peers) {
            // Strictement plus profond, et sur ma branche : un pair au même
            // endroit que moi ne s'entoure pas, il se voit.
            if (peer.path.length <= path.length) continue;
            if (!path.every((mine, i) => peer.path[i] === mine)) continue;
            if (peer.path[path.length] !== segment) continue;
            found.add(peer.color);
        }
        return [...found].sort();
    }, [peers, path, kind, value]);

    // L'abonnement au compteur n'existe que tant qu'il y a de quoi alterner.
    const rotating = colors.length > 1;
    useEffect(() => {
        if (!rotating) return;
        return subscribeTick(setTick);
    }, [rotating]);

    if (colors.length === 0) return {};
    const color = colors[tick % colors.length];
    return {
        'data-live-peer': true,
        style: { '--live-peer': userColorVar(color) } as CSSProperties
    };
}
