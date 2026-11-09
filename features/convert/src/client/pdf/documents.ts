import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';

import type { BuildImage, BuildSource } from './build';
import { imageToPage } from './images';
import { newId, rotateBy, SOURCE_COLORS, type ImageInfo, type PageGeometry, type Plan, type SourceInfo } from './model';
import { openDocument } from './pdfjs';

/**
 * Les fichiers ouverts dans l'atelier, hors de React : leurs octets, pour
 * l'assemblage, et leur document pdf.js, pour l'affichage. Le plan ne porte
 * que des descriptions ; un fichier retiré reste ici jusqu'à la fermeture de
 * l'atelier, pour qu'un « Annuler » le retrouve.
 */

interface OpenedSource {
    bytes: Uint8Array<ArrayBuffer>;
    password: string | null;
    proxy: PDFDocumentProxy;
}

const sources = new Map<string, OpenedSource>();
const images = new Map<string, Uint8Array<ArrayBuffer>>();

/** Les pages se décrivent par lots : un document de mille pages ne fait pas mille allers-retours en file indienne. */
const GEOMETRY_BATCH = 24;

async function geometryOf(proxy: PDFDocumentProxy): Promise<PageGeometry[]> {
    const pages: PageGeometry[] = new Array<PageGeometry>(proxy.numPages);
    for (let start = 0; start < proxy.numPages; start += GEOMETRY_BATCH) {
        const end = Math.min(start + GEOMETRY_BATCH, proxy.numPages);
        await Promise.all(
            Array.from({ length: end - start }, async (_, k) => {
                const page = await proxy.getPage(start + k + 1);
                const [x1, y1, x2, y2] = page.view;
                pages[start + k] = { view: [x1, y1, x2, y2], rotate: rotateBy(page.rotate, 0) };
            })
        );
    }
    return pages;
}

async function hasFields(proxy: PDFDocumentProxy): Promise<boolean> {
    const fields: unknown = await proxy.getFieldObjects().catch(() => null);
    if (!fields) return false;
    return (fields instanceof Map ? fields.size : Object.keys(fields as object).length) > 0;
}

/** Ouvre un PDF. Lève `NeedsPassword` quand le fichier en demande un, ou refuse celui donné. */
export async function openSource(file: File, password: string | null, color: number): Promise<SourceInfo> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const proxy = await openDocument(bytes, password);
    const pages = await geometryOf(proxy);
    const id = newId();
    sources.set(id, { bytes, password, proxy });
    return {
        id,
        name: file.name,
        bytes: bytes.byteLength,
        pages,
        protectedByPassword: password !== null && password !== '',
        hasForm: await hasFields(proxy),
        pureXfa: proxy.isPureXfa,
        color: color % SOURCE_COLORS
    };
}

export async function pageOf(sourceId: string, index: number): Promise<PDFPageProxy | null> {
    const source = sources.get(sourceId);
    return source ? source.proxy.getPage(index + 1) : null;
}

export async function addImage(file: File): Promise<ImageInfo> {
    const { bytes, mime, width, height } = await imageToPage(file);
    const id = newId();
    images.set(id, bytes);
    return { id, name: file.name, width, height, mime };
}

export const imageBytes = (id: string): Uint8Array<ArrayBuffer> | undefined => images.get(id);

/** Ce que l'assemblage reçoit : les octets des fichiers et des images que le plan cite. */
export function buildInputOf(plan: Plan): { sources: BuildSource[]; images: BuildImage[] } {
    return {
        sources: plan.sources.flatMap((s) => {
            const opened = sources.get(s.id);
            return opened ? [{ id: s.id, bytes: opened.bytes, password: opened.password }] : [];
        }),
        images: plan.images.flatMap((i) => {
            const bytes = images.get(i.id);
            return bytes ? [{ id: i.id, bytes, mime: i.mime, width: i.width, height: i.height }] : [];
        })
    };
}

/** À la fermeture de l'atelier : les documents pdf.js libèrent leur worker. */
export function forgetAll(): void {
    for (const source of sources.values()) void source.proxy.loadingTask.destroy().catch(() => undefined);
    sources.clear();
    images.clear();
}
