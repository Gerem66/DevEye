import { useEffect, useSyncExternalStore } from 'react';

/**
 * Largeur demandée par la vue ouverte dans la popup de feature.
 *
 * Certaines vues sont *horizontales par nature* — un kanban, une frise — et la
 * largeur maximale confortable pour lire du texte (1240 px) leur coûte des
 * colonnes entières sur un écran large. Elles annoncent donc la largeur que
 * **leur contenu** réclame, et la rendent en quittant.
 *
 * Une largeur en pixels, et non un booléen « pleine largeur » : un tableau de
 * trois colonnes n'a aucune raison de s'étaler jusqu'aux bords de l'écran. La
 * popup s'ajuste au contenu entre le plancher commun à toutes les features
 * (1240 px) et le maximum absolu (la fenêtre, marges déduites).
 *
 * Pourquoi un store et pas une prop : le contenu d'une feature est **porté dans
 * la popup par un portail** (`FeatureKeepAlive`), pas rendu en enfant de
 * `WidgetPopup`. Faire redescendre l'information par les props obligerait
 * `Pages/Home` à connaître les onglets de chaque feature — exactement le
 * couplage que le module Projets cherche à éviter. Même parti pris que le
 * maintien de la clé (`acquireSecrecyHold`).
 *
 * Un **multi-ensemble** de demandes, et non une valeur unique : deux vues
 * élargies simultanément (une feature et une autre gardée en vie derrière) ne
 * doivent pas se marcher dessus — c'est la plus large qui gagne, et la popup ne
 * rétrécit qu'une fois la dernière relâchée.
 *
 * L'animation reste une **transition CSS** (`transition: max-width`) : la taille
 * se règle après le rendu, donc framer-motion — qui possède la popup via son
 * `layoutId` — n'y voit aucun saut de mise en page à rattraper et ne double pas
 * l'animation d'une projection en `scale` qui déformerait le contenu.
 */

/** Le plancher : la largeur de confort de lecture, commune à toutes les vues. */
export const BASE_MAX_WIDTH = 1240;

/**
 * Marge totale que la popup laisse de chaque côté (`left`/`right: --space-lg`),
 * plus une poignée de pixels de sécurité.
 *
 * L'écrêtage qu'elle permet n'est pas cosmétique : `.popup` a des `inset`
 * gauche/droite, donc sa largeur réelle est déjà bornée par la fenêtre. Animer
 * `max-width` **au-delà** de cette borne ferait saturer la transition en plein
 * vol — la boîte cesserait de grandir à mi-course tout en continuant d'animer
 * une valeur qui ne se voit plus. On n'anime donc jamais vers une valeur
 * inatteignable.
 */
const VIEWPORT_MARGIN = 64;

let requests = new Map<symbol, number>();
const listeners = new Set<() => void>();

/** Mémoïsé : `useSyncExternalStore` exige une valeur stable entre deux rendus. */
let current = BASE_MAX_WIDTH;

function viewportCap(): number {
    if (typeof window === 'undefined') return Number.POSITIVE_INFINITY;
    return Math.max(BASE_MAX_WIDTH, window.innerWidth - VIEWPORT_MARGIN);
}

function recompute(): void {
    let wanted = BASE_MAX_WIDTH;
    for (const px of requests.values()) wanted = Math.max(wanted, px);
    const next = Math.round(Math.min(wanted, viewportCap()));
    if (next === current) return;
    current = next;
    for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

// La fenêtre rétrécit : l'écrêtage doit suivre, sinon la valeur animée
// repasserait au-dessus de ce que les marges autorisent.
if (typeof window !== 'undefined') {
    window.addEventListener('resize', recompute);
}

/** Demande une largeur de contenu ; la fonction rendue relâche la demande. */
export function acquirePopupWidth(px: number): () => void {
    const key = Symbol('popupWidth');
    requests.set(key, px);
    recompute();
    return () => {
        if (!requests.has(key)) return;
        requests.delete(key);
        recompute();
    };
}

/** La largeur maximale que la popup doit adopter, en pixels. */
export function usePopupMaxWidth(): number {
    return useSyncExternalStore(
        subscribe,
        () => current,
        () => BASE_MAX_WIDTH
    );
}

/**
 * Réclame une largeur tant que `px` n'est pas `null`.
 *
 * Le démontage relâche : une feature fermée en plein onglet « Tableau » ne
 * laisse pas la popup élargie derrière elle. Une valeur qui change remplace la
 * demande — c'est ce qui fait suivre la popup quand on ajoute une colonne au
 * kanban ou qu'on change le zoom de la frise.
 */
export function useRequestPopupWidth(px: number | null): void {
    useEffect(() => {
        if (px === null) return;
        return acquirePopupWidth(px);
    }, [px]);
}

/** Remet le store à zéro. Réservé aux tests. */
export function resetPopupWidth(): void {
    requests = new Map();
    recompute();
}
