import type { BuildRedaction } from './build';
import type { PdfElement } from './elements';
import { displayedSize, type Plan, type PlanPage } from './model';
import { paintPage } from './thumbnails';

/** La définition d'une page caviardée : 150 points par pouce, de quoi imprimer. */
const RASTER_SCALE = 150 / 72;
const JPEG_QUALITY = 0.85;

/**
 * Une page caviardée devient une image : le texte sous les rectangles noirs
 * n'existe plus dans le document produit, là où un rectangle posé par-dessus
 * laisserait tout lisible dessous.
 */
export async function redactedPage(
    page: PlanPage,
    plan: Plan,
    redactions: readonly PdfElement[]
): Promise<BuildRedaction> {
    const size = displayedSize(page, plan);
    const canvas = document.createElement('canvas');
    await paintPage(canvas, page, plan, Math.round(size.width * RASTER_SCALE));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Le navigateur ne fournit pas de canevas.');
    const scale = canvas.width / size.width;
    ctx.fillStyle = '#000000';
    for (const r of redactions) ctx.fillRect(r.x * scale, r.y * scale, r.width * scale, r.height * scale);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
    if (!blob) throw new Error('La page caviardée n’a pas pu être dessinée.');
    return { pageId: page.id, bytes: new Uint8Array(await blob.arrayBuffer()), mime: 'image/jpeg', ...size };
}

/** Toutes les pages du plan qui portent un caviardage, dessinées. */
export async function redactedPages(plan: Plan, elements: readonly PdfElement[]): Promise<BuildRedaction[]> {
    const out: BuildRedaction[] = [];
    for (const page of plan.pages) {
        const redactions = elements.filter((e) => e.kind === 'redact' && e.pageId === page.id);
        if (redactions.length > 0) out.push(await redactedPage(page, plan, redactions));
    }
    return out;
}
