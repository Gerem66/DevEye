import { THEME_SLOT_IMAGE_MAX_LENGTH } from '@deveye/types';

/**
 * Background image processing for the appearance gallery. Saved backgrounds are
 * downscaled + recompressed (canvas → WebP data URL) so several fit within the
 * browser's localStorage budget and the server theme column. Pasted URLs are
 * *copied* into a self-contained data URL when possible, so the wallpaper stays
 * independent of the source.
 */

/** Longest edge (px) of a saved background; larger images are scaled down. */
const MAX_EDGE = 1920;
const INITIAL_QUALITY = 0.82;
/**
 * Compression target (chars of the data URL). Well under the hard
 * THEME_SLOT_IMAGE_MAX_LENGTH cap so 5 slots + the active copy stay within the
 * ~5 MB localStorage budget. Typical photos land far below this.
 */
const TARGET_LENGTH = 700_000;

const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'];
/** Max input size before downscaling (the stored result is far smaller). */
const MAX_INPUT_BYTES = 12 * 1024 * 1024;

/** Load an image from any usable src (object URL or remote URL, no byte access). */
export function loadImageFromSrc(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('Image illisible.'));
        img.src = src;
    });
}

function drawToDataUrl(img: HTMLImageElement, scale: number, quality: number): string {
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error("Impossible de traiter l'image.");
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL('image/webp', quality);
}

/**
 * Downscale + compress a loaded image to a data URL that fits the slot budget:
 * first lower the quality, then shrink the dimensions if still too large.
 */
function compress(img: HTMLImageElement): string {
    const maxEdge = Math.max(img.naturalWidth, img.naturalHeight);
    let scale = maxEdge > MAX_EDGE ? MAX_EDGE / maxEdge : 1;
    let quality = INITIAL_QUALITY;
    let url = drawToDataUrl(img, scale, quality);
    while (url.length > TARGET_LENGTH && quality > 0.4) {
        quality -= 0.12;
        url = drawToDataUrl(img, scale, quality);
    }
    while (url.length > THEME_SLOT_IMAGE_MAX_LENGTH && scale > 0.25) {
        scale *= 0.8;
        url = drawToDataUrl(img, scale, quality);
    }
    if (url.length > THEME_SLOT_IMAGE_MAX_LENGTH) {
        throw new Error('Image trop lourde après compression.');
    }
    return url;
}

/** Resize/compress a picked local file into a saveable background data URL. */
export async function fileToBackgroundDataUrl(file: File): Promise<string> {
    if (!ACCEPTED_TYPES.includes(file.type)) {
        throw new Error('Format non supporté (PNG, JPEG, WebP, GIF ou AVIF).');
    }
    if (file.size > MAX_INPUT_BYTES) {
        throw new Error('Image trop volumineuse (12 Mo max).');
    }
    const objUrl = URL.createObjectURL(file);
    try {
        return compress(await loadImageFromSrc(objUrl));
    } finally {
        URL.revokeObjectURL(objUrl);
    }
}

/** Fetch a remote image's bytes and copy them into a self-contained data URL. */
async function urlToBackgroundDataUrl(url: string): Promise<string> {
    const res = await fetch(url, { mode: 'cors' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    if (!blob.type.startsWith('image/')) throw new Error('La ressource n’est pas une image.');
    if (blob.size > MAX_INPUT_BYTES) throw new Error('Image distante trop volumineuse.');
    const objUrl = URL.createObjectURL(blob);
    try {
        return compress(await loadImageFromSrc(objUrl));
    } finally {
        URL.revokeObjectURL(objUrl);
    }
}

/**
 * Turn a pasted URL into a saveable background value. Tries to *copy* the image
 * into a self-contained data URL (independent of the source). If the copy is
 * blocked — typically CORS — the raw URL is kept instead: display still works as
 * long as the source stays online. Throws if the URL isn't a usable image.
 */
export async function resolveBackgroundFromUrl(url: string): Promise<{ value: string; copied: boolean }> {
    try {
        return { value: await urlToBackgroundDataUrl(url), copied: true };
    } catch {
        // Copy failed (CORS/network). Fall back to the raw URL, but make sure it
        // at least loads as an image so we don't pollute a slot with garbage.
        await loadImageFromSrc(url);
        return { value: url, copied: false };
    }
}
