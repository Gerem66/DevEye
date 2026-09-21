/**
 * La qualité à laquelle un JPEG a été enregistré. Le fichier ne la note nulle
 * part : elle se déduit de sa table de quantification, comparée à la table de
 * référence de la norme, selon la formule de l'encodeur IJG que presque tous
 * les logiciels reprennent. Une estimation : un appareil qui a ses propres
 * tables donne une valeur approchée.
 */

/** La table de luminance de la norme (annexe K), dans l'ordre naturel. */
const STANDARD_LUMINANCE = [
    16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51,
    87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101,
    72, 92, 95, 98, 112, 100, 103, 99
];

/** Un fichier range ses tables en zigzag : l'ordre naturel de chaque case, diagonale après diagonale. */
function zigzagOrder(): number[] {
    const order: number[] = [];
    for (let sum = 0; sum < 15; sum++) {
        const diagonal: number[] = [];
        for (let y = 0; y < 8; y++) {
            const x = sum - y;
            if (x >= 0 && x < 8) diagonal.push(y * 8 + x);
        }
        order.push(...(sum % 2 === 0 ? diagonal.reverse() : diagonal));
    }
    return order;
}

const ZIGZAG = zigzagOrder();
const SOI = 0xffd8;
const DQT = 0xdb;
const SOS = 0xda;

/** La table de luminance (numéro 0) d'un JPEG, dans l'ordre naturel. `null` : ce n'en est pas un, ou elle manque. */
function luminanceTable(bytes: Uint8Array): number[] | null {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.byteLength < 4 || view.getUint16(0) !== SOI) return null;
    let at = 2;
    // De segment en segment, par leur longueur : la vignette d'un bloc EXIF porte ses propres tables, qu'on enjambe ainsi.
    while (at + 4 <= view.byteLength && view.getUint8(at) === 0xff) {
        const marker = view.getUint8(at + 1);
        const length = view.getUint16(at + 2);
        if (marker === SOS) return null;
        if (marker === DQT) {
            let cursor = at + 4;
            const end = at + 2 + length;
            while (cursor < end && cursor < view.byteLength) {
                const wide = view.getUint8(cursor) >> 4 === 1;
                const id = view.getUint8(cursor) & 0x0f;
                const size = wide ? 128 : 64;
                if (cursor + 1 + size > view.byteLength) return null;
                if (id === 0) {
                    const table = new Array<number>(64);
                    for (let i = 0; i < 64; i++) {
                        table[ZIGZAG[i]] = wide ? view.getUint16(cursor + 1 + i * 2) : view.getUint8(cursor + 1 + i);
                    }
                    return table;
                }
                cursor += 1 + size;
            }
        }
        at += 2 + length;
    }
    return null;
}

/** De 1 à 100, ou `null` quand le fichier n'est pas un JPEG lisible. */
export function estimateJpegQuality(bytes: Uint8Array): number | null {
    const table = luminanceTable(bytes);
    if (!table) return null;
    const scale = table.reduce((sum, value, i) => sum + (value * 100) / STANDARD_LUMINANCE[i], 0) / 64;
    const quality = scale <= 100 ? (200 - scale) / 2 : 5000 / scale;
    return Math.min(100, Math.max(1, Math.round(quality)));
}

/** Les tables précèdent l'image, mais des blocs de métadonnées peuvent les repousser loin. */
const HEAD_BYTES = 512 * 1024;

export async function jpegQualityOf(file: File): Promise<number | null> {
    try {
        return estimateJpegQuality(new Uint8Array(await file.slice(0, HEAD_BYTES).arrayBuffer()));
    } catch {
        return null;
    }
}
