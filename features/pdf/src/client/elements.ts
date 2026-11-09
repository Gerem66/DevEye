import type { Point, Rect } from './geometry';
import type { Size } from './model';

/**
 * Ce qu'on pose sur une page : signatures, textes, coches, images,
 * surlignages, rectangles, traits et caviardages. Les positions sont dans le
 * repère du cadre affiché de la page (origine en haut à gauche, en points,
 * page tournée comme à l'écran) ; `geometry.ts` les ramène dans le fichier.
 */

export type InkColor = 'black' | 'blue' | 'red' | 'green';
export type HighlightColor = 'yellow' | 'green' | 'blue' | 'pink';

/** Les encres du document : des couleurs d'impression, pas des jetons du thème. */
export const INK: Record<InkColor, { label: string; rgb: readonly [number, number, number] }> = {
    black: { label: 'Noir', rgb: [0.1, 0.1, 0.12] },
    blue: { label: 'Bleu', rgb: [0.12, 0.28, 0.75] },
    red: { label: 'Rouge', rgb: [0.8, 0.16, 0.16] },
    green: { label: 'Vert', rgb: [0.1, 0.55, 0.3] }
};

export const HIGHLIGHT: Record<HighlightColor, { label: string; rgb: readonly [number, number, number] }> = {
    yellow: { label: 'Jaune', rgb: [1, 0.92, 0.3] },
    green: { label: 'Vert', rgb: [0.6, 0.95, 0.5] },
    blue: { label: 'Bleu', rgb: [0.55, 0.82, 1] },
    pink: { label: 'Rose', rgb: [1, 0.65, 0.82] }
};

export const HIGHLIGHT_OPACITY = 0.45;

export type SignatureData =
    /** Un tracé, dans sa propre boîte (y vers le bas), étiré dans celle de l'élément. */
    | { kind: 'path'; path: string; width: number; height: number; stroke: number }
    /** Un nom écrit dans la police manuscrite. */
    | { kind: 'text'; text: string }
    /** Une image importée, détourée ou non. */
    | { kind: 'image'; assetId: string; width: number; height: number };

export interface ElementBase {
    id: string;
    pageId: string;
    x: number;
    y: number;
    width: number;
    height: number;
    /** Reproduit sur chaque page, à la même distance des bords les plus proches (un paraphe). */
    everyPage: boolean;
}

export type PdfElement =
    | (ElementBase & { kind: 'signature'; signature: SignatureData; color: InkColor })
    | (ElementBase & { kind: 'text'; text: string; size: number; color: InkColor; hand: boolean })
    | (ElementBase & { kind: 'mark'; mark: 'check' | 'cross'; color: InkColor })
    | (ElementBase & { kind: 'image'; assetId: string })
    | (ElementBase & { kind: 'highlight'; color: HighlightColor })
    | (ElementBase & { kind: 'box'; fill: 'white' | 'none'; border: InkColor | null })
    | (ElementBase & {
          kind: 'ink';
          path: string;
          pathWidth: number;
          pathHeight: number;
          color: InkColor;
          stroke: number;
      })
    | (ElementBase & { kind: 'redact' });

export type ElementKind = PdfElement['kind'];

export const ELEMENT_LABELS: Record<ElementKind, string> = {
    signature: 'Signature',
    text: 'Texte',
    mark: 'Coche',
    image: 'Image',
    highlight: 'Surlignage',
    box: 'Rectangle',
    ink: 'Trait',
    redact: 'Caviardage'
};

/** Les tracés des coches, dans une boîte de 24. */
export const MARK_BOX = 24;
export const MARK_PATHS: Record<'check' | 'cross', string> = {
    check: 'M 3 12.5 L 9.5 19 L 21 5',
    cross: 'M 4 4 L 20 20 M 20 4 L 4 20'
};

export const MIN_ELEMENT_SIZE = 6;
/** Les éléments dont la boîte garde ses proportions quand on la redimensionne. */
export const KEEPS_ASPECT: readonly ElementKind[] = ['signature', 'mark', 'image', 'ink'];
/** Ceux qui peuvent se répéter sur toutes les pages. */
export const CAN_REPEAT: readonly ElementKind[] = ['signature', 'text', 'mark', 'image'];

export const TEXT_LINE_HEIGHT = 1.2;
export const DEFAULT_TEXT_SIZE = 12;

/** « 09/11/2026 » : la date du jour, comme on la signe. */
export const todayLabel = (now = new Date()): string =>
    `${String(now.getDate()).padStart(2, '0')}/${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()}`;

/** La hauteur d'un texte : ses lignes, à l'interligne du rendu. */
export function textHeight(text: string, size: number): number {
    return Math.max(1, text.split('\n').length) * size * TEXT_LINE_HEIGHT;
}

export function clampToPage(rect: Rect, page: Size): Rect {
    const width = Math.min(rect.width, page.width);
    const height = Math.min(rect.height, page.height);
    return {
        x: Math.min(Math.max(0, rect.x), page.width - width),
        y: Math.min(Math.max(0, rect.y), page.height - height),
        width,
        height
    };
}

/** Une boîte de `size` centrée sur un point, ramenée dans la page. */
export function centredBox(at: Point, size: Size, page: Size): Rect {
    return clampToPage({ x: at.x - size.width / 2, y: at.y - size.height / 2, ...size }, page);
}

/** Le rectangle tendu entre deux points, bords dans l'ordre. */
export function rectBetween(a: Point, b: Point): Rect {
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
}

/**
 * Où va la copie d'un élément sur une autre page : à la même distance de
 * l'horizontale et de la verticale dont il est le plus proche. Un paraphe en
 * bas à droite d'un A4 reste en bas à droite d'une page paysage.
 */
export function replicate(rect: Rect, from: Size, to: Size): Rect {
    const fromRight = from.width - (rect.x + rect.width);
    const fromBottom = from.height - (rect.y + rect.height);
    const x = rect.x <= fromRight ? rect.x : to.width - rect.width - fromRight;
    const y = rect.y <= fromBottom ? rect.y : to.height - rect.height - fromBottom;
    return clampToPage({ x, y, width: rect.width, height: rect.height }, to);
}

/**
 * La boîte d'un élément quand sa page tourne : son coin suit la page, ses
 * dimensions restent (l'élément se lit toujours droit), et elle reste dedans.
 */
export function rotateRect(rect: Rect, page: Size, delta: 90 | -90 | 180): Rect {
    const turned = delta === 180 ? page : { width: page.height, height: page.width };
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    let centre: Point;
    switch (delta) {
        case 90:
            centre = { x: page.height - cy, y: cx };
            break;
        case -90:
            centre = { x: cy, y: page.width - cx };
            break;
        default:
            centre = { x: page.width - cx, y: page.height - cy };
    }
    return centredBox(centre, { width: rect.width, height: rect.height }, turned);
}

/** Un tracé à main levée, ramené dans sa boîte englobante, avec deux décimales. */
export function inkPath(points: readonly Point[], stroke: number): { path: string; box: Rect } | null {
    if (points.length === 0) return null;
    const pad = stroke / 2;
    const minX = Math.min(...points.map((p) => p.x)) - pad;
    const minY = Math.min(...points.map((p) => p.y)) - pad;
    const maxX = Math.max(...points.map((p) => p.x)) + pad;
    const maxY = Math.max(...points.map((p) => p.y)) + pad;
    const f = (n: number) => Math.round(n * 100) / 100;
    const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${f(p.x - minX)} ${f(p.y - minY)}`).join(' ');
    return { path, box: { x: minX, y: minY, width: Math.max(maxX - minX, 0.01), height: Math.max(maxY - minY, 0.01) } };
}

/** Plusieurs traits (un par pression) dans une seule boîte. */
export function strokesPath(
    strokes: readonly (readonly Point[])[],
    stroke: number
): { path: string; box: Rect } | null {
    const all = strokes.flat();
    if (all.length === 0) return null;
    const bounds = inkPath(all, stroke);
    if (!bounds) return null;
    const f = (n: number) => Math.round(n * 100) / 100;
    const path = strokes
        .filter((s) => s.length > 0)
        .map((s) =>
            s.map((p, i) => `${i === 0 ? 'M' : 'L'} ${f(p.x - bounds.box.x)} ${f(p.y - bounds.box.y)}`).join(' ')
        )
        .join(' ');
    return { path, box: bounds.box };
}

export const elementsOn = (elements: readonly PdfElement[], pageId: string): PdfElement[] =>
    elements.filter((e) => e.pageId === pageId);

export const rectOf = (e: ElementBase): Rect => ({ x: e.x, y: e.y, width: e.width, height: e.height });
