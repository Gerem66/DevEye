import type { TargetFormat } from './catalogue';
import { cropRect, imageDims, keptSeconds, scaledDims, videoDims, type Dims } from './geometry';
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
    /**
     * Le débit du son, en kb/s. Dans le navigateur il ne se connaît que pour un
     * fichier audio (son poids rapporté à sa durée) ; le serveur le lit aussi
     * dans la piste d'une vidéo.
     */
    audioKbps: number | null;
}

/**
 * Le débit d'un son qui garde sa qualité d'origine : celui du fichier, dans ce
 * que le curseur de débit de la cible (`sliderId`) admet.
 */
export function keptBitrate(target: TargetFormat, sliderId: string, audioKbps: number): number {
    const slider = target.options.find((spec) => spec.kind === 'slider' && spec.id === sliderId);
    if (slider?.kind !== 'slider') return audioKbps;
    return Math.min(slider.max, Math.max(slider.min, Math.round(audioKbps)));
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

/**
 * Les dimensions du fichier produit, d'après celles de l'original et les
 * réglages. `null` quand la cible n'a pas d'image, ou que l'original n'a pas
 * laissé lire les siennes.
 */
export function outputDims(target: TargetFormat, values: OptionValues, info: MediaInfo): Dims | null {
    if (!info.width || !info.height) return null;
    const source = { width: info.width, height: info.height };
    switch (target.recipe.engine) {
        case 'video': {
            const height = str(values, 'height');
            return videoDims(source, cropOf(values, 'crop'), height && height !== 'source' ? Number(height) : null);
        }
        case 'gif': {
            return scaledDims(cropRect(source, cropOf(values, 'crop')) ?? source, num(values, 'gifScale') ?? 50);
        }
        case 'image':
            return imageDims(source, cropOf(values, 'crop'), sizeOf(values, 'resize'));
        default:
            return null;
    }
}

export function estimateSize(target: TargetFormat, values: OptionValues, info: MediaInfo): SizeEstimate | null {
    const recipe = target.recipe;
    switch (recipe.engine) {
        case 'video': {
            if (str(values, 'mode') === 'size') {
                const bytes = num(values, 'targetBytes');
                return bytes ? { bytes, exact: true } : null;
            }
            const dims = outputDims(target, values, info);
            if (!info.durationMs || !dims) return null;
            const seconds = keptSeconds(info.durationMs, num(values, 'trimStart'), num(values, 'trimEnd'));
            const fpsChoice = str(values, 'fps');
            const fps = fpsChoice && fpsChoice !== 'source' ? Number(fpsChoice) : (info.fps ?? DEFAULT_FPS);
            const bitsPerPixel = geometric(...VIDEO_BITS_PER_PIXEL, (num(values, 'quality') ?? 65) / 100);
            const video = dims.width * dims.height * fps * bitsPerPixel * recipe.efficiency;
            // Débit du son gardé : le navigateur ne lit pas celui d'une piste vidéo. Celui d'un son ordinaire en tient lieu.
            const audioKbps = flag(values, 'keepAudioBitrate')
                ? keptBitrate(target, 'audioBitrate', info.audioKbps ?? 128)
                : (num(values, 'audioBitrate') ?? 128);
            const audio = flag(values, 'audio') ? audioKbps * 1000 : 0;
            return { bytes: Math.round(((video + audio) * seconds * (1 + recipe.overhead)) / 8), exact: false };
        }
        case 'gif': {
            const dims = outputDims(target, values, info);
            if (!info.durationMs || !dims) return null;
            const seconds = keptSeconds(info.durationMs, num(values, 'trimStart'), num(values, 'trimEnd'));
            const frames = seconds * (num(values, 'gifFps') ?? 12);
            return { bytes: Math.round(dims.width * dims.height * frames * GIF_BYTES_PER_PIXEL), exact: false };
        }
        case 'audio': {
            if (!info.durationMs) return null;
            const seconds = keptSeconds(info.durationMs, num(values, 'trimStart'), num(values, 'trimEnd'));
            if (recipe.lossy) {
                // Débit d'origine gardé, mais inconnu ici (le son d'une vidéo) : seul le serveur le lira.
                const keep = flag(values, 'keepBitrate');
                if (keep && info.audioKbps === null) return null;
                const kbps =
                    keep && info.audioKbps !== null
                        ? keptBitrate(target, 'bitrate', info.audioKbps)
                        : (num(values, 'bitrate') ?? 192);
                const bitrate = kbps * 1000;
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
            const dims = outputDims(target, values, info);
            if (!dims) return null;
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
