/** Ce que l'export d'un tableau sait produire, sans rien charger d'Excalidraw. */

export type ImageFormat = 'png' | 'jpeg' | 'webp' | 'svg';

export interface ImageFormatChoice {
    value: ImageFormat;
    label: string;
    mime: string;
    extension: string;
    hint: string;
}

export const IMAGE_FORMATS: readonly ImageFormatChoice[] = [
    {
        value: 'png',
        label: 'PNG',
        mime: 'image/png',
        extension: 'png',
        hint: 'Net et sans perte, le fond peut rester transparent : le choix le plus sûr.'
    },
    {
        value: 'jpeg',
        label: 'JPEG',
        mime: 'image/jpeg',
        extension: 'jpg',
        hint: 'Plus léger et lu partout, mais sans transparence : le fond reste.'
    },
    {
        value: 'webp',
        label: 'WebP',
        mime: 'image/webp',
        extension: 'webp',
        hint: 'Léger et net, le fond peut rester transparent. Quelques logiciels anciens ne le lisent pas.'
    },
    {
        value: 'svg',
        label: 'SVG',
        mime: 'image/svg+xml',
        extension: 'svg',
        hint: 'Vectoriel : il s’agrandit sans perdre en netteté, pour l’impression ou une page web.'
    }
];

export const formatOf = (format: ImageFormat): ImageFormatChoice =>
    IMAGE_FORMATS.find((choice) => choice.value === format) ?? IMAGE_FORMATS[0];

/** Ce que l'utilisateur règle avant d'exporter. */
export interface ImageOptions {
    format: ImageFormat;
    /** La sélection seule, plutôt que tout le tableau. */
    selectionOnly: boolean;
    /** Le fond du tableau ; sans lui, l'image est transparente. */
    background: boolean;
    dark: boolean;
}

export const IMAGE_SCALES = [1, 2, 3] as const;

/**
 * Au-delà, le navigateur refuse de créer le canevas : Chrome plafonne un côté
 * à 16 384 pixels, Firefox l'image entière à environ 500 Mo.
 */
const MAX_SIDE = 16_384;
const MAX_PIXELS = 100_000_000;

/** L'agrandissement demandé, réduit s'il le faut pour que le navigateur sache dessiner l'image. */
export function boundedScale(width: number, height: number, scale: number): number {
    if (width <= 0 || height <= 0) return scale;
    return Math.min(scale, MAX_SIDE / Math.max(width, height), Math.sqrt(MAX_PIXELS / (width * height)));
}

/** Les dimensions de l'image en pixels, depuis celles de la scène à l'échelle 1. */
export function pixelSize(width: number, height: number, scale: number): { width: number; height: number } {
    const bounded = boundedScale(width, height, scale);
    return { width: Math.round(width * bounded), height: Math.round(height * bounded) };
}

const FORBIDDEN = '\\/:*?"<>|';

/** Le nom du fichier : le titre du tableau, sans ce qu'un système de fichiers refuse. */
export function imageFileName(title: string, format: ImageFormat): string {
    const cleaned = [...title]
        .map((char) => (char.charCodeAt(0) < 32 || FORBIDDEN.includes(char) ? ' ' : char))
        .join('')
        .replace(/\s+/g, ' ')
        .replace(/^[\s.]+|[\s.]+$/g, '')
        .slice(0, 120)
        .trim();
    return `${cleaned || 'Tableau blanc'}.${formatOf(format).extension}`;
}

/**
 * Ce que « la sélection » exporte, comme le fait Excalidraw : les éléments
 * choisis, le texte écrit dans une forme choisie et le contenu d'un cadre
 * choisi, qui ne figurent pas eux-mêmes dans la sélection.
 */
export function selectionForExport<T extends { id: string; frameId?: string | null; containerId?: string | null }>(
    elements: readonly T[],
    selected: Readonly<Record<string, boolean>>
): T[] {
    return elements.filter(
        (element) =>
            selected[element.id] === true ||
            (element.containerId != null && selected[element.containerId] === true) ||
            (element.frameId != null && selected[element.frameId] === true)
    );
}
