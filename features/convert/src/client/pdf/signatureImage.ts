import { addAsset } from './documents';
import type { SignatureData } from './elements';

/** Le côté long d'une signature importée : au-delà, l'image pèse sans rien ajouter. */
const MAX_SIDE = 1200;
/** Ce qu'on tient pour du papier blanc quand on détoure une signature scannée. */
const WHITE_FROM = 225;

/**
 * Une image de signature prête à être posée : un PNG, avec le fond blanc
 * rendu transparent si on le demande (le scan d'une signature sur papier).
 */
export async function importSignature(file: File, removeWhite: boolean): Promise<SignatureData> {
    let bitmap: ImageBitmap;
    try {
        bitmap = await createImageBitmap(file);
    } catch {
        throw new Error(`« ${file.name} » n’est pas une image lisible.`);
    }
    try {
        const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height, 1));
        const width = Math.max(1, Math.round(bitmap.width * scale));
        const height = Math.max(1, Math.round(bitmap.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Le navigateur ne fournit pas de canevas.');
        ctx.drawImage(bitmap, 0, 0, width, height);
        if (removeWhite) {
            const image = ctx.getImageData(0, 0, width, height);
            const px = image.data;
            for (let i = 0; i < px.length; i += 4) {
                const light = Math.min(px[i], px[i + 1], px[i + 2]);
                // Du blanc franc disparaît ; un gris clair s'estompe, pour un bord sans crénelage.
                if (light >= WHITE_FROM) px[i + 3] = 0;
                else if (light >= WHITE_FROM - 40) px[i + 3] = Math.round((px[i + 3] * (WHITE_FROM - light)) / 40);
            }
            ctx.putImageData(image, 0, 0);
        }
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
        if (!blob) throw new Error('La signature n’a pas pu être préparée.');
        const assetId = addAsset(new Uint8Array(await blob.arrayBuffer()), 'image/png');
        return { kind: 'image', assetId, width, height };
    } finally {
        bitmap.close();
    }
}

/** Les proportions d'une signature écrite, mesurées dans la police manuscrite. */
export function handTextAspect(text: string, family: string): number {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return 3;
    ctx.font = `48px '${family}'`;
    const width = Math.max(ctx.measureText(text || 'Signature').width, 24);
    return width / (48 * 1.2);
}
