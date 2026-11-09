/** Le fond des images sans transparence et des pages blanches : du papier, pas une couleur du thème. */
export const PAPER = '#ffffff';

/** Le côté long d'une image gardée dans le document : un A4 à 300 points par pouce. */
const MAX_SIDE = 2480;

export interface PageImage {
    bytes: Uint8Array<ArrayBuffer>;
    mime: 'image/png' | 'image/jpeg';
    width: number;
    height: number;
}

/**
 * Une image telle que pdf-lib l'embarque. Un PNG passe tel quel, transparence
 * comprise. Les autres passent par le canevas : un JPEG de téléphone y
 * retrouve son orientation, qu'il porte dans ses métadonnées et que pdf-lib
 * ignore, et une photo de 12 mégapixels se réduit à ce qu'une page imprime.
 */
export async function imageToPage(file: File): Promise<PageImage> {
    let bitmap: ImageBitmap;
    try {
        bitmap = await createImageBitmap(file);
    } catch {
        throw new Error(`« ${file.name} » n’est pas une image lisible.`);
    }
    try {
        const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height, 1));
        if (file.type === 'image/png' && scale === 1) {
            const bytes = new Uint8Array(await file.arrayBuffer());
            return { bytes, mime: 'image/png', width: bitmap.width, height: bitmap.height };
        }
        const width = Math.max(1, Math.round(bitmap.width * scale));
        const height = Math.max(1, Math.round(bitmap.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Le navigateur ne fournit pas de canevas.');
        const lossless = file.type === 'image/png' || file.type === 'image/gif';
        if (!lossless) {
            ctx.fillStyle = PAPER;
            ctx.fillRect(0, 0, width, height);
        }
        ctx.drawImage(bitmap, 0, 0, width, height);
        const mime = lossless ? 'image/png' : 'image/jpeg';
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mime, 0.9));
        if (!blob) throw new Error(`« ${file.name} » n’a pas pu être préparée.`);
        return { bytes: new Uint8Array(await blob.arrayBuffer()), mime, width, height };
    } finally {
        bitmap.close();
    }
}
