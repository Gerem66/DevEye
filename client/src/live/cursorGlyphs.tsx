import type { LiveCursorKind } from 'deveye-types';
import type { ReactNode } from 'react';

/**
 * Le dessin de chaque état de curseur.
 *
 * Sept formes, tenues à la main plutôt qu'empruntées aux icônes du thème : un
 * curseur doit se lire à seize pixels **et** garder la silhouette que tout le
 * monde reconnaît d'un système à l'autre. Les icônes de l'interface, dessinées
 * pour des boutons, n'ont ni cette silhouette ni ce poids de trait.
 *
 * `hotspot` est le point du dessin qui doit tomber sur la position reçue — la
 * pointe pour une flèche, le doigt pour une main, le centre pour une barre de
 * texte. Sans lui, un curseur de texte serait décalé d'une demi-hauteur et
 * désignerait la mauvaise ligne.
 */
interface GlyphSpec {
    width: number;
    height: number;
    viewBox: string;
    /** `[x, y]` dans le repère du `viewBox`. */
    hotspot: [number, number];
    /** Décalage de l'étiquette sous le dessin, en pixels. */
    labelOffset: number;
    shape: ReactNode;
}

export interface CursorGlyph extends GlyphSpec {
    /** Le point chaud ramené en pixels, prêt à être soustrait de la position. */
    offsetX: number;
    offsetY: number;
}

/**
 * Convertit le point chaud du repère du `viewBox` vers les pixels du dessin.
 * Fait une fois au chargement : le rendu n'a plus qu'une soustraction.
 */
function withOffsets(specs: Record<LiveCursorKind, GlyphSpec>): Record<LiveCursorKind, CursorGlyph> {
    const out = {} as Record<LiveCursorKind, CursorGlyph>;
    for (const [kind, spec] of Object.entries(specs) as [LiveCursorKind, GlyphSpec][]) {
        const [, , boxW, boxH] = spec.viewBox.split(/\s+/).map(Number);
        out[kind] = {
            ...spec,
            offsetX: (spec.hotspot[0] / boxW) * spec.width,
            offsetY: (spec.hotspot[1] / boxH) * spec.height
        };
    }
    return out;
}

/** Contour sombre commun : décolle chaque forme d'un fond clair comme sombre. */
const OUTLINE = { stroke: 'rgba(0,0,0,0.5)', strokeWidth: 1, strokeLinejoin: 'round' as const };

export const CURSOR_GLYPHS: Record<LiveCursorKind, CursorGlyph> = withOffsets({
    default: {
        width: 14,
        height: 20,
        viewBox: '0 0 14 20',
        hotspot: [1, 1],
        labelOffset: 12,
        shape: <path d='M1 1 L1 16.5 L5.2 12.6 L7.8 18.6 L10.6 17.4 L8 11.5 L13 11.2 Z' {...OUTLINE} />
    },

    // Main pointant vers le haut : l'index est le point de contact.
    pointer: {
        width: 17,
        height: 21,
        viewBox: '0 0 20 24',
        hotspot: [8, 1],
        labelOffset: 14,
        shape: (
            <path
                d='M6.4 1.9a1.6 1.6 0 0 1 3.2 0v8.4h1.3a3.2 3.2 0 0 1 3.2 3.2v3.4a5.5 5.5 0 0 1-5.5 5.5H8a4.6 4.6 0 0 1-3.4-1.5l-3-3.3a1.5 1.5 0 0 1 2.1-2.1l2.7 2.3V1.9Z'
                {...OUTLINE}
            />
        )
    },

    // Barre de texte : son centre est le point de contact, pas son sommet.
    text: {
        width: 8,
        height: 18,
        viewBox: '0 0 10 22',
        hotspot: [5, 11],
        labelOffset: 13,
        shape: (
            <g fill='none' stroke='currentColor' strokeWidth='1.7' strokeLinecap='round'>
                <path d='M2.2 2h5.6M2.2 20h5.6M5 2v18' />
            </g>
        )
    },

    // Main ouverte : le milieu de la paume suit le pointeur.
    grab: {
        width: 19,
        height: 20,
        viewBox: '0 0 22 24',
        hotspot: [11, 6],
        labelOffset: 15,
        shape: (
            <path
                d='M5.6 11V5.4a1.4 1.4 0 0 1 2.8 0v5.2h.7V3.9a1.4 1.4 0 0 1 2.8 0v6.7h.7V4.8a1.4 1.4 0 0 1 2.8 0v5.8h.7V7.4a1.4 1.4 0 0 1 2.8 0v7.4a7.4 7.4 0 0 1-7.4 7.4h-1a5 5 0 0 1-3.6-1.5l-4-4.1a1.5 1.5 0 0 1 2.1-2.1l1.6 1.4V11Z'
                {...OUTLINE}
            />
        )
    },

    // Poing fermé : mêmes proportions, doigts repliés — la différence se lit.
    grabbing: {
        width: 19,
        height: 18,
        viewBox: '0 0 22 22',
        hotspot: [11, 6],
        labelOffset: 13,
        shape: (
            <path
                d='M5.4 10.4V8.6a1.4 1.4 0 0 1 2.8 0v1.4h.7V7.6a1.4 1.4 0 0 1 2.8 0v2.4h.7V8.2a1.4 1.4 0 0 1 2.8 0v1.8h.7V9.4a1.4 1.4 0 0 1 2.8 0v4.2a6.8 6.8 0 0 1-6.8 6.8H10a6 6 0 0 1-6-6v-3.5a1.4 1.4 0 0 1 1.4-1.4Z'
                {...OUTLINE}
            />
        )
    },

    resize: {
        width: 22,
        height: 12,
        viewBox: '0 0 24 12',
        hotspot: [12, 6],
        labelOffset: 10,
        shape: (
            <g fill='none' stroke='currentColor' strokeWidth='1.8' strokeLinecap='round' strokeLinejoin='round'>
                <path d='M2 6h20M5 3 2 6l3 3M19 3l3 3-3 3' />
            </g>
        )
    },

    blocked: {
        width: 17,
        height: 17,
        viewBox: '0 0 20 20',
        hotspot: [10, 10],
        labelOffset: 12,
        shape: (
            <g fill='none' stroke='currentColor' strokeWidth='2'>
                <circle cx='10' cy='10' r='8' />
                <path d='M4.3 15.7 15.7 4.3' />
            </g>
        )
    }
});
