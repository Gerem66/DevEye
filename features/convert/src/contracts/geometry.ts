import type { CropValue, SizeValue } from './options';

/** Les dimensions d'une image ou d'une vidéo, en pixels. */
export interface Dims {
    width: number;
    height: number;
}

/** Une zone de l'image, origine en haut à gauche. */
export interface Rect extends Dims {
    x: number;
    y: number;
}

/** Ce qu'un recadrage laisse au moins, par côté : un codec refuse une image d'un pixel. */
const MIN_KEPT = 2;

/** Deux marges opposées, ramenées à ce que le côté peut perdre. La première l'emporte. */
function clampPair(near: number, far: number, length: number): [number, number] {
    const room = Math.max(0, length - MIN_KEPT);
    const first = Math.min(near, room);
    return [first, Math.min(far, room - first)];
}

/** La zone que des marges laissent. `null` quand elles ne retirent rien. */
export function cropRect(source: Dims, crop: CropValue | null): Rect | null {
    if (!crop) return null;
    const [left, right] = clampPair(crop.left, crop.right, source.width);
    const [top, bottom] = clampPair(crop.top, crop.bottom, source.height);
    if (left + right + top + bottom === 0) return null;
    return { x: left, y: top, width: source.width - left - right, height: source.height - top - bottom };
}

/** Un codec vidéo n'accepte que des dimensions paires. */
const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2);

/** Tenir dans un cadre en gardant les proportions, sans jamais agrandir. */
export function fitInside(source: Dims, box: { width: number | null; height: number | null }): Dims {
    const ratio = Math.min(box.width ? box.width / source.width : 1, box.height ? box.height / source.height : 1, 1);
    return {
        width: Math.max(1, Math.round(source.width * ratio)),
        height: Math.max(1, Math.round(source.height * ratio))
    };
}

/**
 * Les dimensions demandées pour une image. Proportions gardées, elle tient dans
 * le cadre donné (une seule dimension suffit à le fixer) ; sinon elle prend
 * exactement celles-ci. Agrandir est permis : c'est un choix explicite.
 */
export function resizeDims(source: Dims, size: SizeValue): Dims {
    if (size.width === null && size.height === null) return source;
    if (!size.keepRatio) return { width: size.width ?? source.width, height: size.height ?? source.height };
    const scale = Math.min(
        size.width ? size.width / source.width : Infinity,
        size.height ? size.height / source.height : Infinity
    );
    return {
        width: Math.max(1, Math.round(source.width * scale)),
        height: Math.max(1, Math.round(source.height * scale))
    };
}

/** Ce que devient une vidéo : recadrée, puis ramenée à la hauteur demandée, en dimensions paires. */
export function videoDims(source: Dims, crop: CropValue | null, maxHeight: number | null): Dims {
    const base: Dims = cropRect(source, crop) ?? source;
    const fitted = maxHeight ? fitInside(base, { width: null, height: maxHeight }) : base;
    return { width: even(fitted.width), height: even(fitted.height) };
}

/** Ce que devient une image : recadrée, puis mise aux dimensions demandées. */
export function imageDims(source: Dims, crop: CropValue | null, size: SizeValue): Dims {
    return resizeDims(cropRect(source, crop) ?? source, size);
}

/** La durée gardée, en secondes, une fois le passage découpé. */
export function keptSeconds(durationMs: number, trimStart: number | null, trimEnd: number | null): number {
    const total = durationMs / 1000;
    const start = Math.min(Math.max(trimStart ?? 0, 0), total);
    const end = trimEnd !== null && trimEnd > start ? Math.min(trimEnd, total) : total;
    return Math.max(0, end - start);
}
