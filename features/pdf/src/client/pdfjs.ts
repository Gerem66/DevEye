import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

import { PDFJS_ASSETS } from './assetPath';

type Pdfjs = typeof import('pdfjs-dist');

let loading: Promise<Pdfjs> | null = null;

/** pdf.js, chargé à la première ouverture d'un fichier : l'accueil du Convertisseur ne le paie pas. */
export function loadPdfjs(): Promise<Pdfjs> {
    loading ??= import('pdfjs-dist').then((pdfjs) => {
        pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
        return pdfjs;
    });
    return loading;
}

/** Le fichier demande un mot de passe. `incorrect` : celui qu'on a donné ne convient pas. */
export class NeedsPassword extends Error {
    constructor(readonly incorrect: boolean) {
        super(incorrect ? 'Ce mot de passe ne convient pas.' : 'Ce PDF est protégé par un mot de passe.');
    }
}

export async function openDocument(bytes: Uint8Array, password: string | null): Promise<PDFDocumentProxy> {
    const pdfjs = await loadPdfjs();
    const task = pdfjs.getDocument({
        // pdf.js prend possession du tampon reçu : une copie, les octets servent encore à l'assemblage.
        data: bytes.slice(),
        password: password ?? undefined,
        cMapUrl: `${PDFJS_ASSETS}cmaps/`,
        cMapPacked: true,
        standardFontDataUrl: `${PDFJS_ASSETS}standard_fonts/`,
        wasmUrl: `${PDFJS_ASSETS}wasm/`,
        // La politique de contenu de l'app ne laisse pas compiler de WebAssembly :
        // les décodeurs d'images en JavaScript prennent le relais.
        useWasm: false
    });
    try {
        return await task.promise;
    } catch (e) {
        if (e instanceof pdfjs.PasswordException) {
            throw new NeedsPassword(e.code === pdfjs.PasswordResponses.INCORRECT_PASSWORD);
        }
        throw new Error('Ce fichier n’est pas un PDF lisible : il est peut-être abîmé.');
    }
}

/** Dessine la page dans le canevas, large de `width` pixels, tournée de `rotation` (la rotation totale, celle du fichier comprise). */
export async function renderPage(
    page: PDFPageProxy,
    canvas: HTMLCanvasElement,
    width: number,
    rotation: number
): Promise<void> {
    const base = page.getViewport({ scale: 1, rotation });
    const viewport = page.getViewport({ scale: width / base.width, rotation });
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const canvasContext = canvas.getContext('2d');
    if (!canvasContext) throw new Error('Le navigateur ne fournit pas de canevas.');
    await page.render({ canvas, canvasContext, viewport }).promise;
}
