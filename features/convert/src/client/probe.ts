import type { ConvertKind } from '../contracts/catalogue';
import type { MediaInfo } from '../contracts/estimate';
import { jpegQualityOf } from './jpegQuality';

/**
 * Ce que le navigateur sait lire d'un fichier sans l'envoyer : de quoi poser
 * des réglages cohérents et estimer la taille. Un format qu'il ne sait pas
 * ouvrir (MKV, HEIC) rend des champs vides, et l'écran le dit ; le serveur,
 * lui, relira le fichier pour de bon.
 */

const PROBE_TIMEOUT_MS = 8000;

/** Ce que le navigateur lit en plus, et dont le serveur n'a pas besoin. */
export interface FileInfo extends MediaInfo {
    /** La qualité à laquelle un JPEG a été enregistré. `null` pour tout autre fichier. */
    sourceQuality: number | null;
}

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

export async function probeFile(file: File, kind: ConvertKind): Promise<FileInfo> {
    const base: FileInfo = {
        bytes: file.size,
        durationMs: null,
        width: null,
        height: null,
        fps: null,
        sourceQuality: null
    };
    if (kind === 'video' || kind === 'audio') return { ...base, ...(await probeElement(file, kind)) };
    if (kind === 'image') {
        const [dims, sourceQuality] = await Promise.all([probeImage(file), jpegQualityOf(file)]);
        return { ...base, ...dims, sourceQuality };
    }
    return base;
}
