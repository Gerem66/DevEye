import type { TargetFormat } from './catalogue';
import { cropRect, imageDims, keptSeconds, videoDims } from './geometry';
import { cropOf, flag, num, sizeOf, str, type OptionValues } from './options';

/**
 * La taille du fichier avant de l'avoir produit. Exacte quand un débit ou une
 * taille est imposé, approchée quand c'est une qualité qui est demandée : le
 * poids dépend alors de ce que l'image contient, que seul l'encodage révèle.
 */

/** Ce qu'on sait du fichier d'entrée. Lu dans le navigateur, relu par le serveur. */
export interface MediaInfo {
    bytes: number;
    durationMs: number | null;
    width: number | null;
    height: number | null;
    fps: number | null;
}

export interface SizeEstimate {
    bytes: number;
    exact: boolean;
}

/** Interpolation géométrique : le poids d'un encodage croît en proportion, pas en ligne droite. */
function geometric(low: number, high: number, t: number): number {
    return low * Math.pow(high / low, Math.min(1, Math.max(0, t)));
}

/** Bits par pixel du H.264, de la qualité la plus basse à la plus haute. */
const VIDEO_BITS_PER_PIXEL: readonly [number, number] = [0.012, 0.2];
const DEFAULT_FPS = 30;
/** Octets par pixel et par image d'un GIF de vidéo, palette et compression comprises. */
const GIF_BYTES_PER_PIXEL = 0.3;

/**
 * En dessous, l'image n'est plus regardable : mieux vaut refuser que livrer
 * une bouillie. Croît avec la surface, plancher à 100 kb/s.
 */
export function minVideoBitrate(width: number, height: number): number {
    return Math.max(100_000, Math.round(width * height * 0.45));
}

/**
 * Le débit vidéo qui fait tenir un fichier dans une taille : ce qui reste une
 * fois l'enveloppe et le son payés. Négatif ou nul quand le son seul dépasse.
 */
export function videoBitrateForTarget(
    targetBytes: number,
    seconds: number,
    audioBitrate: number,
    overhead: number
): number {
    if (seconds <= 0) return 0;
    return Math.floor((targetBytes * 8) / (1 + overhead) / seconds - audioBitrate);
}

/** La plus petite taille cible qui reste regardable, pour la dire à l'utilisateur. */
export function minTargetBytes(
    width: number,
    height: number,
    seconds: number,
    audioBitrate: number,
    overhead: number
): number {
    return Math.ceil(((minVideoBitrate(width, height) + audioBitrate) * seconds * (1 + overhead)) / 8);
}

export function estimateSize(target: TargetFormat, values: OptionValues, info: MediaInfo): SizeEstimate | null {
    const recipe = target.recipe;
    switch (recipe.engine) {
        case 'video': {
            if (str(values, 'mode') === 'size') {
                const bytes = num(values, 'targetBytes');
                return bytes ? { bytes, exact: true } : null;
            }
            if (!info.durationMs || !info.width || !info.height) return null;
            const seconds = keptSeconds(info.durationMs, num(values, 'trimStart'), num(values, 'trimEnd'));
            const height = str(values, 'height');
            const dims = videoDims(
                { width: info.width, height: info.height },
                cropOf(values, 'crop'),
                height && height !== 'source' ? Number(height) : null
            );
            const fpsChoice = str(values, 'fps');
            const fps = fpsChoice && fpsChoice !== 'source' ? Number(fpsChoice) : (info.fps ?? DEFAULT_FPS);
            const bitsPerPixel = geometric(...VIDEO_BITS_PER_PIXEL, (num(values, 'quality') ?? 65) / 100);
            const video = dims.width * dims.height * fps * bitsPerPixel * recipe.efficiency;
            const audio = flag(values, 'audio') ? (num(values, 'audioBitrate') ?? 128) * 1000 : 0;
            return { bytes: Math.round(((video + audio) * seconds * (1 + recipe.overhead)) / 8), exact: false };
        }
        case 'gif': {
            if (!info.durationMs || !info.width || !info.height) return null;
            const seconds = keptSeconds(info.durationMs, num(values, 'trimStart'), num(values, 'trimEnd'));
            const full = { width: info.width, height: info.height };
            const source = cropRect(full, cropOf(values, 'crop')) ?? full;
            const width = Math.min(num(values, 'gifWidth') ?? 480, source.width);
            const height = (width * source.height) / source.width;
            const frames = seconds * (num(values, 'gifFps') ?? 12);
            return { bytes: Math.round(width * height * frames * GIF_BYTES_PER_PIXEL), exact: false };
        }
        case 'audio': {
            if (!info.durationMs) return null;
            const seconds = keptSeconds(info.durationMs, num(values, 'trimStart'), num(values, 'trimEnd'));
            if (recipe.lossy) {
                const bitrate = (num(values, 'bitrate') ?? 192) * 1000;
                return { bytes: Math.round((bitrate * seconds * (1 + recipe.overhead)) / 8), exact: true };
            }
            // Fréquence et canaux de l'original ne se lisent pas dans le navigateur :
            // ceux d'un CD, et l'estimation se dit approchée.
            const rate = Number(str(values, 'sampleRate')) || 44_100;
            const channels = Number(str(values, 'channels')) || 2;
            const pcm = rate * channels * 2 * seconds;
            return { bytes: Math.round(recipe.codec === 'flac' ? pcm * 0.6 : pcm), exact: false };
        }
        case 'image': {
            if (!info.width || !info.height) return null;
            const dims = imageDims(
                { width: info.width, height: info.height },
                cropOf(values, 'crop'),
                sizeOf(values, 'resize')
            );
            const quality = recipe.lossy ? ((num(values, 'quality') ?? 82) - 1) / 99 : 1;
            const bytesPerPixel = geometric(recipe.bytesPerPixel[0], recipe.bytesPerPixel[1], quality);
            return { bytes: Math.round(dims.width * dims.height * bytesPerPixel), exact: false };
        }
        case 'pdfCompress': {
            const ratio = { screen: 0.35, ebook: 0.55, printer: 0.8 }[str(values, 'level') ?? 'ebook'] ?? 0.55;
            return { bytes: Math.round(info.bytes * ratio), exact: false };
        }
        case 'office':
        case 'pdfImage':
        case 'pdfText':
            return null;
    }
}
