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

/** Les cadences qu'un fichier a vraiment : une mesure qui tombe à côté s'y range. */
const COMMON_FPS = [12, 15, 23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 90, 120];
const FPS_FRAMES = 12;
const FPS_TIMEOUT_MS = 2500;

/**
 * La cadence d'une vidéo, que le navigateur ne dit nulle part : on en lit
 * quelques images, muettes et hors de l'écran, et on relève l'écart entre leurs
 * instants. Le plus petit écart, et non la moyenne : une machine qui saute des
 * images allonge des écarts, jamais ne les raccourcit. `null` quand le
 * navigateur ne sait pas compter les images, ou pas lire ce fichier.
 */
function measureFps(video: HTMLVideoElement): Promise<number | null> {
    if (!('requestVideoFrameCallback' in video)) return Promise.resolve(null);
    return new Promise((resolve) => {
        const times: number[] = [];
        const finish = (): void => {
            clearTimeout(timer);
            video.pause();
            const gaps = times
                .slice(1)
                .map((time, i) => time - times[i])
                .filter((gap) => gap > 0.001);
            if (gaps.length < 3) return resolve(null);
            const measured = 1 / Math.min(...gaps);
            const nearest = COMMON_FPS.reduce((a, b) => (Math.abs(b - measured) < Math.abs(a - measured) ? b : a));
            resolve(Math.abs(nearest - measured) / measured < 0.04 ? nearest : Math.round(measured));
        };
        const timer = setTimeout(finish, FPS_TIMEOUT_MS);
        const onFrame = (_now: number, frame: { mediaTime: number }): void => {
            times.push(frame.mediaTime);
            if (times.length >= FPS_FRAMES) finish();
            else video.requestVideoFrameCallback(onFrame);
        };
        video.requestVideoFrameCallback(onFrame);
        video.muted = true;
        void video.play().catch(finish);
    });
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
            const read: Partial<MediaInfo> = {
                durationMs: Number.isFinite(element.duration) ? Math.round(element.duration * 1000) : null,
                width: video?.videoWidth || null,
                height: video?.videoHeight || null
            };
            if (!video) return finish(read);
            clearTimeout(timer);
            void measureFps(video).then((fps) => finish({ ...read, fps }));
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
        audioKbps: null,
        sourceQuality: null
    };
    if (kind === 'video') return { ...base, ...(await probeElement(file, kind)) };
    if (kind === 'audio') {
        const media = await probeElement(file, kind);
        const seconds = (media.durationMs ?? 0) / 1000;
        // Le poids rapporté à la durée : juste pour un fichier qui n'est que du son, faux dès qu'il y a une image.
        return { ...base, ...media, audioKbps: seconds > 0 ? Math.round((file.size * 8) / seconds / 1000) : null };
    }
    if (kind === 'image') {
        const [dims, sourceQuality] = await Promise.all([probeImage(file), jpegQualityOf(file)]);
        return { ...base, ...dims, sourceQuality };
    }
    return base;
}
