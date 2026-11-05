import { SCENE_MAX_ELEMENTS, fileMimeSchema, type SceneElement, type WhiteboardFileMime } from '../contracts/domain';

export interface ImportedBoard {
    title: string;
    elements: SceneElement[];
    files: { id: string; mimeType: WhiteboardFileMime; dataURL: string }[];
    filesBytes: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/**
 * Un `.excalidraw` lu sans Excalidraw (la grille ne le charge pas) : les champs
 * que la fusion exige, complétés pour les fichiers d'anciennes versions, et les
 * images que la scène montre encore. Le serveur revérifie tout.
 */
export function parseExcalidraw(name: string, text: string): ImportedBoard {
    let data: unknown;
    try {
        data = JSON.parse(text);
    } catch {
        throw new Error('Ce fichier n’est pas un dessin Excalidraw.');
    }
    if (!isRecord(data) || data.type !== 'excalidraw' || !Array.isArray(data.elements)) {
        throw new Error('Ce fichier n’est pas un dessin Excalidraw.');
    }
    const now = Date.now();
    const elements: SceneElement[] = [];
    for (const raw of data.elements) {
        if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.type !== 'string' || raw.isDeleted === true)
            continue;
        elements.push({
            ...raw,
            id: raw.id,
            type: raw.type,
            version: Number.isInteger(raw.version) && Number(raw.version) > 0 ? Number(raw.version) : 1,
            versionNonce: Number.isInteger(raw.versionNonce)
                ? Number(raw.versionNonce)
                : Math.floor(Math.random() * 2 ** 31),
            isDeleted: false,
            updated: typeof raw.updated === 'number' ? raw.updated : now
        } as SceneElement);
    }
    if (elements.length > SCENE_MAX_ELEMENTS) throw new Error('Ce dessin compte trop d’éléments pour être importé.');

    const shown = new Set(
        elements.filter((el) => el.type === 'image' && typeof el.fileId === 'string').map((el) => el.fileId as string)
    );
    const files: ImportedBoard['files'] = [];
    let filesBytes = 0;
    if (isRecord(data.files)) {
        for (const [id, file] of Object.entries(data.files)) {
            if (!shown.has(id) || !isRecord(file) || typeof file.dataURL !== 'string') continue;
            const mime = fileMimeSchema.safeParse(file.mimeType);
            if (!mime.success) continue;
            files.push({ id, mimeType: mime.data, dataURL: file.dataURL });
            filesBytes += Math.floor((file.dataURL.length * 3) / 4);
        }
    }
    return { title: name.replace(/\.(excalidraw|json)$/i, '').trim(), elements, files, filesBytes };
}
