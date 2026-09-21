import type { CropValue, SizeValue } from './options';

/** Les dimensions d'une image ou d'une vidéo, en pixels. */
export interface Dims {
    width: number;
    height: number;
}

/** Le recadrage demandé, ramené dans l'image. `null` s'il n'en reste rien. */
export function clampCrop(source: Dims, crop: CropValue | null): CropValue | null {
    if (!crop) return null;
    const x = Math.min(crop.x, source.width - 1);
    const y = Math.min(crop.y, source.height - 1);
    const width = Math.min(crop.width, source.width - x);
    const height = Math.min(crop.height, source.height - y);
    if (width < 2 || height < 2) return null;
    if (x === 0 && y === 0 && width === source.width && height === source.height) return null;
    return { x, y, width, height };
}

/** Un codec vidéo n'accepte que des dimensions paires. */
const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2);

/** Tenir dans un cadre en gardant les proportions, sans jamais agrandir. */
export function fitInside(source: Dims, box: SizeValue): Dims {
    const ratio = Math.min(box.width ? box.width / source.width : 1, box.height ? box.height / source.height : 1, 1);
    return {
        width: Math.max(1, Math.round(source.width * ratio)),
        height: Math.max(1, Math.round(source.height * ratio))
    };
}

/** Ce que devient une vidéo : recadrée, puis ramenée à la hauteur demandée, en dimensions paires. */
export function videoDims(source: Dims, crop: CropValue | null, maxHeight: number | null): Dims {
    const cropped = clampCrop(source, crop);
    const base: Dims = cropped ? { width: cropped.width, height: cropped.height } : source;
    const fitted = maxHeight ? fitInside(base, { width: null, height: maxHeight }) : base;
    return { width: even(fitted.width), height: even(fitted.height) };
}

/** Ce que devient une image : recadrée, puis ramenée dans le cadre demandé. */
export function imageDims(source: Dims, crop: CropValue | null, box: SizeValue): Dims {
    const cropped = clampCrop(source, crop);
    return fitInside(cropped ? { width: cropped.width, height: cropped.height } : source, box);
}

/** La durée gardée, en secondes, une fois le passage découpé. */
export function keptSeconds(durationMs: number, trimStart: number | null, trimEnd: number | null): number {
    const total = durationMs / 1000;
    const start = Math.min(Math.max(trimStart ?? 0, 0), total);
    const end = trimEnd !== null && trimEnd > start ? Math.min(trimEnd, total) : total;
    return Math.max(0, end - start);
}
