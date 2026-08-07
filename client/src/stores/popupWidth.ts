import { useEffect, useSyncExternalStore } from 'react';

/**
 * Demande d'élargissement de la popup de feature.
 *
 * Certaines vues sont *horizontales par nature* — un kanban, une frise — et la
 * largeur maximale confortable pour lire du texte (1240 px) leur coûte des
 * colonnes entières sur un écran large. Elles réclament donc ponctuellement
 * toute la largeur, et la rendent en quittant.
 *
 * Pourquoi un store et pas une prop : le contenu d'une feature est **porté dans
 * la popup par un portail** (`FeatureKeepAlive`), pas rendu en enfant de
 * `WidgetPopup`. Faire redescendre l'information par les props obligerait
 * `Pages/Home` à connaître les onglets de chaque feature — exactement le
 * couplage que le module Projets cherche à éviter. Même parti pris que le
 * maintien de la clé (`acquireSecrecyHold`) : un compteur global, acquis et
 * relâché par celui qui en a besoin.
 *
 * Un **compteur**, et non un booléen : deux vues élargies simultanément (une
 * feature et une autre gardée en vie derrière) ne doivent pas se marcher dessus
 * — la popup ne rétrécit qu'une fois la dernière relâchée.
 *
 * L'animation, elle, est purement CSS (`transition: max-width`) : elle ne
 * change donc pas la géométrie *au moment du rendu*, et framer-motion — qui
 * possède la popup via son `layoutId` — n'y voit aucun saut de mise en page à
 * rattraper.
 */

let count = 0;
const listeners = new Set<() => void>();

function emit(): void {
    for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** Prend une demande d'élargissement ; la fonction rendue la relâche. */
export function acquirePopupWide(): () => void {
    count += 1;
    if (count === 1) emit();
    let released = false;
    return () => {
        if (released) return;
        released = true;
        count = Math.max(0, count - 1);
        if (count === 0) emit();
    };
}

/** `true` tant qu'au moins une vue réclame la pleine largeur. */
export function usePopupWide(): boolean {
    return useSyncExternalStore(
        subscribe,
        () => count > 0,
        () => false
    );
}

/**
 * Réclame la pleine largeur tant que `active` est vrai.
 *
 * Le démontage relâche : une feature fermée en plein onglet « Tableau » ne
 * laisse pas la popup élargie derrière elle.
 */
export function useRequestPopupWide(active: boolean): void {
    useEffect(() => {
        if (!active) return;
        return acquirePopupWide();
    }, [active]);
}
