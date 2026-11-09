import type { PageBox, Rotation, Size } from './model';

/**
 * Deux repères : celui du fichier (origine en bas à gauche, y vers le haut,
 * avant rotation) et celui du cadre affiché (origine en haut à gauche, y vers
 * le bas, page tournée). pdf.js passe de l'un à l'autre par une matrice ; la
 * voici, à l'échelle 1, pour que ce que l'on pose sur l'écran retombe au même
 * endroit dans le fichier, quelle que soit la rotation de la page et l'origine
 * de sa boîte.
 */

export interface Frame {
    view: PageBox;
    rotation: Rotation;
}

export interface Point {
    x: number;
    y: number;
}

export interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** [a, b, c, d, e, f] : x' = a x + c y + e, y' = b x + d y + f. */
export type Matrix = readonly [number, number, number, number, number, number];

export function frameSize(frame: Frame): Size {
    const [x1, y1, x2, y2] = frame.view;
    return frame.rotation % 180 === 0 ? { width: x2 - x1, height: y2 - y1 } : { width: y2 - y1, height: x2 - x1 };
}

/** Du fichier vers le cadre affiché, comme `PageViewport` de pdf.js à l'échelle 1. */
export function viewMatrix(frame: Frame): Matrix {
    const [x1, y1, x2, y2] = frame.view;
    const centerX = (x1 + x2) / 2;
    const centerY = (y1 + y2) / 2;
    let a: number, b: number, c: number, d: number;
    switch (frame.rotation) {
        case 180:
            [a, b, c, d] = [-1, 0, 0, 1];
            break;
        case 90:
            [a, b, c, d] = [0, 1, 1, 0];
            break;
        case 270:
            [a, b, c, d] = [0, -1, -1, 0];
            break;
        default:
            [a, b, c, d] = [1, 0, 0, -1];
    }
    const offsetX = a === 0 ? Math.abs(centerY - y1) : Math.abs(centerX - x1);
    const offsetY = a === 0 ? Math.abs(centerX - x1) : Math.abs(centerY - y1);
    return [a, b, c, d, offsetX - a * centerX - c * centerY, offsetY - b * centerX - d * centerY];
}

export function invert(m: Matrix): Matrix {
    const [a, b, c, d, e, f] = m;
    const det = a * d - b * c;
    return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

export const apply = (m: Matrix, p: Point): Point => ({
    x: m[0] * p.x + m[2] * p.y + m[4],
    y: m[1] * p.x + m[3] * p.y + m[5]
});

export const toView = (frame: Frame, p: Point): Point => apply(viewMatrix(frame), p);
export const toUser = (frame: Frame, p: Point): Point => apply(invert(viewMatrix(frame)), p);

/** Un rectangle du cadre affiché, dans le repère du fichier : axes alignés, la rotation étant droite. */
export function userRect(frame: Frame, rect: Rect): Rect {
    const a = toUser(frame, { x: rect.x, y: rect.y });
    const b = toUser(frame, { x: rect.x + rect.width, y: rect.y + rect.height });
    return {
        x: Math.min(a.x, b.x),
        y: Math.min(a.y, b.y),
        width: Math.abs(b.x - a.x),
        height: Math.abs(b.y - a.y)
    };
}

/**
 * Où pdf-lib pose un objet qu'on veut voir droit à l'écran : le point du
 * fichier sous son coin bas-gauche affiché, et la rotation à lui donner, qui
 * est celle de la page (le lecteur la défait en affichant).
 */
export function anchor(frame: Frame, rect: Rect): { x: number; y: number; rotate: Rotation } {
    const p = toUser(frame, { x: rect.x, y: rect.y + rect.height });
    return { x: p.x, y: p.y, rotate: frame.rotation };
}
