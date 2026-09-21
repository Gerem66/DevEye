import type { ConvertKind } from '../contracts/catalogue';
import type { MediaInfo } from '../contracts/estimate';

/**
 * Ce que le navigateur sait lire d'un fichier sans l'envoyer : de quoi poser
 * des réglages cohérents et estimer la taille. Un format qu'il ne sait pas
 * ouvrir (MKV, HEIC) rend des champs vides, et l'écran le dit ; le serveur,
 * lui, relira le fichier pour de bon.
 */

const PROBE_TIMEOUT_MS = 8000;

function probeElement(file: File, tag: 'video' | 'audio'): Promise<Partial<MediaInfo>> {
    return new Promise((resolve) => {
        const element = document.createElement(tag);
        const url = URL.createObjectURL(file);
        const finish = (info: Partial<MediaInfo>): void => {
            clearTimeout(timer);
            URL.revokeObjectURL(url);
            resolve(info);
        };
        const timer = setTimeout(() => finish({}), PROBE_TIMEOUT_MS);
        element.preload = 'metadata';
        element.onloadedmetadata = () => {
            const video = element instanceof HTMLVideoElement ? element : null;
            finish({
                durationMs: Number.isFinite(element.duration) ? Math.round(element.duration * 1000) : null,
                width: video?.videoWidth || null,
                height: video?.videoHeight || null
            });
        };
        element.onerror = () => finish({});
        element.src = url;
    });
}

async function probeImage(file: File): Promise<Partial<MediaInfo>> {
    try {
        const bitmap = await createImageBitmap(file);
        const info = { width: bitmap.width, height: bitmap.height };
        bitmap.close();
        return info;
    } catch {
        return {};
    }
}

export async function probeFile(file: File, kind: ConvertKind): Promise<MediaInfo> {
    const base: MediaInfo = { bytes: file.size, durationMs: null, width: null, height: null, fps: null };
    if (kind === 'video' || kind === 'audio') return { ...base, ...(await probeElement(file, kind)) };
    if (kind === 'image') return { ...base, ...(await probeImage(file)) };
    return base;
}
