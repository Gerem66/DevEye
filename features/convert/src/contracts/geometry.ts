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
export const MIN_KEPT = 2;

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

/** Le rapport entre des dimensions demandées et la zone qu'elles redimensionnent, axe par axe. */
export interface Scale {
    x: number;
    y: number;
}

/** L'échelle que des dimensions demandent à une zone. Une dimension laissée libre vaut 1. */
export function scaleOf(size: SizeValue, area: Dims): Scale {
    return { x: (size.width ?? area.width) / area.width, y: (size.height ?? area.height) / area.height };
}

/**
 * Les dimensions qui gardent une échelle sur une autre zone : ce que devient un
 * redimensionnement quand le recadrage change. Partir de l'échelle, et non des
 * dimensions précédentes, évite qu'un arrondi s'ajoute à chaque geste. Retomber
 * sur la zone elle-même vaut « inchangé ».
 */
export function sizeAtScale(size: SizeValue, scale: Scale, area: Dims): SizeValue {
    const width = Math.max(1, Math.round(area.width * scale.x));
    const height = Math.max(1, Math.round(area.height * scale.y));
    return width === area.width && height === area.height
        ? { ...size, width: null, height: null }
        : { ...size, width, height };
}

/** Des dimensions ramenées à un pourcentage, en gardant les proportions. */
export function scaledDims(source: Dims, percent: number): Dims {
    return {
        width: Math.max(1, Math.round((source.width * percent) / 100)),
        height: Math.max(1, Math.round((source.height * percent) / 100))
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
