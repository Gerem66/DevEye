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
    /**
     * Le débit d'un fichier audio, en kb/s : son poids rapporté à sa durée. `null`
     * ailleurs : dans une vidéo, l'image pèse l'essentiel et le calcul ne dirait rien du son.
     */
    sourceKbps: number | null;
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
        sourceQuality: null,
        sourceKbps: null
    };
    if (kind === 'video') return { ...base, ...(await probeElement(file, kind)) };
    if (kind === 'audio') {
        const media = await probeElement(file, kind);
        const seconds = (media.durationMs ?? 0) / 1000;
        return { ...base, ...media, sourceKbps: seconds > 0 ? Math.round((file.size * 8) / seconds / 1000) : null };
    }
    if (kind === 'image') {
        const [dims, sourceQuality] = await Promise.all([probeImage(file), jpegQualityOf(file)]);
        return { ...base, ...dims, sourceQuality };
    }
    return base;
}
