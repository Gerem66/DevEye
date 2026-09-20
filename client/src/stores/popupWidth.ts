import { useEffect, useSyncExternalStore } from 'react';

/**
 * Largeur demandée par la vue ouverte dans la popup de feature : une vue
 * horizontale par nature annonce la largeur que son contenu réclame, entre le
 * plancher commun et la fenêtre, marges déduites.
 *
 * Un store et pas une prop, le contenu d'une feature étant porté dans la popup
 * par un portail (`FeatureKeepAlive`). Les demandes forment un multi-ensemble et
 * la plus large gagne : deux vues élargies à la fois, dont une gardée en vie
 * derrière, ne doivent pas se marcher dessus.
 *
 * L'animation reste une transition CSS : framer-motion, qui possède la popup via
 * son `layoutId`, ne doit pas la doubler d'une projection en `scale` qui
 * déformerait le contenu.
 */

/** Le plancher : la largeur de confort de lecture, commune à toutes les vues. */
export const BASE_MAX_WIDTH = 1240;

/**
 * Marge totale que la popup laisse de chaque côté, plus quelques pixels. `.popup`
 * a des `inset` gauche/droite, donc animer `max-width` au-delà de la fenêtre
 * saturerait la transition à mi-course.
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

/**
 * Les changements d'une même frame n'en font qu'un. Changer de vue relâche une
 * demande puis en pose une autre : notifiées une à une, la popup viserait un
 * instant la largeur intermédiaire, et une transition `ease` re-ciblée en vol
 * repart à vitesse nulle, ce qui se voit comme un arrêt au milieu du geste.
 */
let scheduled: number | null = null;

function scheduleRecompute(): void {
    if (typeof window === 'undefined') {
        recompute();
        return;
    }
    if (scheduled !== null) return;
    scheduled = window.requestAnimationFrame(() => {
        scheduled = null;
        recompute();
    });
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
    scheduleRecompute();
    return () => {
        if (!requests.has(key)) return;
        requests.delete(key);
        scheduleRecompute();
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
 * Réclame une largeur tant que `px` n'est pas `null`. Le démontage relâche, pour
 * qu'une feature fermée ne laisse pas la popup élargie derrière elle, et une
 * valeur qui change remplace la demande.
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
