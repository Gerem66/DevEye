import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { ProjectCard } from '../../contracts/domain';

/**
 * Déplacer les dates d'une carte à la souris, sur la frise.
 *
 * Trois gestes sur une même barre, distingués par l'endroit où on l'attrape :
 * le bord gauche déplace le début, le bord droit l'échéance, et le milieu les
 * deux ensemble, du même nombre de jours.
 *
 * Le geste ne persiste rien avant le relâchement : tant que le pointeur est
 * enfoncé, seul un aperçu local bouge. Une frise qui écrirait à chaque pixel
 * enverrait cinquante commandes pour un seul déplacement, et la carte
 * sauterait de ligne sous le pointeur au premier rechargement.
 */

/** Ce qu'on tient : une extrémité, ou la barre entière. */
export type DragMode = 'start' | 'due' | 'move';

/** Les dates telles qu'elles seront si on relâche maintenant. */
export interface DatePreview {
    cardId: number;
    startDate: number | null;
    dueDate: number | null;
}

interface Options {
    /** Pixels par jour : c'est ce qui convertit un déplacement en durée. */
    dayWidth: number;
    /** Persiste le geste. Appelé une fois, au relâchement, jamais pendant. */
    onCommit: (card: ProjectCard, startDate: number | null, dueDate: number | null) => void;
}

/** En deçà, c'est encore un clic : la carte s'ouvre au lieu de bouger. */
const DRAG_THRESHOLD = 3;

/**
 * Décale une date d'un nombre de jours **calendaires**, en heure locale.
 *
 * Et non de `n × 86 400 s` : les dates de ce module sont des minuits locaux
 * (voir `dateInputToSeconds`), et un changement d'heure d'été décalerait ce
 * minuit d'une heure à chaque passage — au bout de deux, une date posée sur le
 * 12 se relirait le 11 à 23 h.
 */
function shiftDays(seconds: number, days: number): number {
    const d = new Date(seconds * 1000);
    d.setDate(d.getDate() + days);
    return Math.floor(d.getTime() / 1000);
}

/**
 * Les dates de la carte après un déplacement de `days` jours.
 *
 * L'inversion est le point délicat : ramener le bord gauche au-delà du bord
 * droit ne bloque pas le geste, il échange les rôles. La date qu'on tient reste
 * celle qu'on tient ; c'est le `min`/`max` avec l'extrémité restée fixe qui
 * décide laquelle des deux est désormais le début. La poignée passe donc de
 * l'autre côté sans qu'on ait à la lâcher, et le geste se poursuit dans le même
 * mouvement.
 */
function applyDrag(card: ProjectCard, mode: DragMode, days: number): DatePreview {
    const { startDate, dueDate } = card;

    // Une seule date connue : rien à étirer, l'unique repère se déplace.
    if (startDate === null || dueDate === null) {
        return {
            cardId: card.id,
            startDate: startDate === null ? null : shiftDays(startDate, days),
            dueDate: dueDate === null ? null : shiftDays(dueDate, days)
        };
    }

    if (mode === 'move') {
        return { cardId: card.id, startDate: shiftDays(startDate, days), dueDate: shiftDays(dueDate, days) };
    }

    const moved = mode === 'start' ? shiftDays(startDate, days) : shiftDays(dueDate, days);
    const anchor = mode === 'start' ? dueDate : startDate;
    return { cardId: card.id, startDate: Math.min(moved, anchor), dueDate: Math.max(moved, anchor) };
}

/**
 * Où l'on vient d'attraper la barre.
 *
 * Les zones de bord sont bornées au tiers de la largeur : sur une barre de deux
 * jours, deux poignées de 10 px ne laisseraient aucun milieu, et la barre ne
 * pourrait plus être déplacée d'un bloc.
 */
export function modeAt(rect: DOMRect, clientX: number, resizable: boolean): DragMode {
    if (!resizable) return 'move';
    const edge = Math.min(10, rect.width / 3);
    if (clientX - rect.left <= edge) return 'start';
    if (rect.right - clientX <= edge) return 'due';
    return 'move';
}

export function useDateDrag({ dayWidth, onCommit }: Options) {
    const [preview, setPreview] = useState<DatePreview | null>(null);

    /** Le geste en cours. Un `ref` : les écouteurs le lisent hors du rendu. */
    const press = useRef<{ card: ProjectCard; mode: DragMode; pointerId: number; x: number } | null>(null);
    /** Le seuil a été franchi : le relâchement ne doit plus ouvrir la carte. */
    const moved = useRef(false);
    /** L'aperçu courant, pour que le relâchement le persiste sans re-rendu. */
    const latest = useRef<DatePreview | null>(null);

    // Les valeurs changeantes passent par des `ref` : les cinq écouteurs sont
    // créés une fois pour toutes, comme dans `dragReorder`.
    const dayWidthRef = useRef(dayWidth);
    dayWidthRef.current = dayWidth;
    const onCommitRef = useRef(onCommit);
    onCommitRef.current = onCommit;

    const handlers = useRef<{
        move: (e: PointerEvent) => void;
        up: (e: PointerEvent) => void;
        cancel: (e: PointerEvent) => void;
        blur: () => void;
        keydown: (e: KeyboardEvent) => void;
    } | null>(null);

    const end = useCallback(() => {
        const h = handlers.current;
        if (h) {
            window.removeEventListener('pointermove', h.move);
            window.removeEventListener('pointerup', h.up);
            window.removeEventListener('pointercancel', h.cancel);
            window.removeEventListener('blur', h.blur);
            window.removeEventListener('keydown', h.keydown);
        }
        document.body.style.removeProperty('cursor');
        document.body.style.removeProperty('user-select');
        press.current = null;
        latest.current = null;
        setPreview(null);
    }, []);

    const endRef = useRef(end);
    endRef.current = end;

    if (handlers.current === null) {
        handlers.current = {
            move: (e) => {
                const p = press.current;
                if (!p || e.pointerId !== p.pointerId) return;
                const dx = e.clientX - p.x;
                if (!moved.current) {
                    if (Math.abs(dx) < DRAG_THRESHOLD) return;
                    moved.current = true;
                    document.body.style.cursor = p.mode === 'move' ? 'grabbing' : 'ew-resize';
                    document.body.style.userSelect = 'none';
                }
                const next = applyDrag(p.card, p.mode, Math.round(dx / dayWidthRef.current));
                latest.current = next;
                setPreview(next);
            },
            up: (e) => {
                const p = press.current;
                if (!p || e.pointerId !== p.pointerId) return;
                const result = moved.current ? latest.current : null;
                const card = p.card;
                endRef.current();
                // Rien n'a bougé d'un jour entier : inutile de réécrire les
                // mêmes dates, le serveur n'apprendrait rien.
                if (!result) return;
                if (result.startDate === card.startDate && result.dueDate === card.dueDate) return;
                onCommitRef.current(card, result.startDate, result.dueDate);
            },
            cancel: (e) => {
                if (press.current?.pointerId !== e.pointerId) return;
                endRef.current();
            },
            blur: () => endRef.current(),
            keydown: (e) => {
                // Échap abandonne : les dates reviennent à ce qu'elles étaient.
                if (e.key === 'Escape') endRef.current();
            }
        };
    }

    // Un geste ne doit pas survivre à la disparition de la frise (changement
    // d'onglet, popup refermée en plein glissé).
    useEffect(() => () => endRef.current(), []);

    const onBarPointerDown = useCallback((e: ReactPointerEvent, card: ProjectCard, mode: DragMode) => {
        if (e.button !== 0) return;
        const h = handlers.current;
        if (!h) return;
        moved.current = false;
        press.current = { card, mode, pointerId: e.pointerId, x: e.clientX };
        window.addEventListener('pointermove', h.move);
        window.addEventListener('pointerup', h.up);
        window.addEventListener('pointercancel', h.cancel);
        window.addEventListener('blur', h.blur);
        window.addEventListener('keydown', h.keydown);
    }, []);

    /** Le clic qui suit un glissé n'est pas un clic : il n'ouvre pas la carte. */
    const consumeClick = useCallback(() => {
        if (!moved.current) return false;
        moved.current = false;
        return true;
    }, []);

    return { preview, onBarPointerDown, consumeClick };
}
