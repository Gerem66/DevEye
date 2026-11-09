import handUrl from '@fontsource/caveat/files/caveat-latin-400-normal.woff?url';

import { PDFJS_ASSETS } from './assetPath';
import type { BuildFonts } from './build';

/**
 * Les deux polices que l'atelier écrit dans un PDF : une sans-serif Unicode
 * (celle que pdf.js embarque déjà pour les PDF sans police) pour les textes et
 * les numéros, une manuscrite pour une signature écrite. Les mêmes fichiers
 * servent à l'écran, pour que l'aperçu soit ce qui sera imprimé.
 */

export const HAND_FONT_FAMILY = 'DevEye Hand';
export const SANS_FONT_URL = `${PDFJS_ASSETS}standard_fonts/LiberationSans-Regular.ttf`;
export const HAND_FONT_URL: string = handUrl;

let handFace: Promise<void> | null = null;

/** La police manuscrite, prête pour l'écran. */
export function loadHandFont(): Promise<void> {
    handFace ??= (async () => {
        const face = new FontFace(HAND_FONT_FAMILY, `url(${HAND_FONT_URL})`);
        await face.load();
        document.fonts.add(face);
    })().catch(() => undefined);
    return handFace;
}

const bytes = new Map<string, Promise<Uint8Array<ArrayBuffer> | null>>();

function fontBytes(url: string): Promise<Uint8Array<ArrayBuffer> | null> {
    let pending = bytes.get(url);
    if (!pending) {
        pending = fetch(url)
            .then(async (r) => (r.ok ? new Uint8Array(await r.arrayBuffer()) : null))
            .catch(() => null);
        bytes.set(url, pending);
    }
    return pending;
}

/** Les octets des polices pour l'assemblage ; `null` quand une police ne s'obtient pas (Helvetica prend le relais). */
export async function buildFonts(): Promise<BuildFonts> {
    const [sans, hand] = await Promise.all([fontBytes(SANS_FONT_URL), fontBytes(HAND_FONT_URL)]);
    return { sans, hand };
}
