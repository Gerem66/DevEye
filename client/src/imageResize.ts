/**
 * Réduire une image déposée à une vignette carrée : recadrer au carré, mettre à
 * l'échelle, et rester sous la borne que le contrat impose à la charge utile. Le
 * faire dans le navigateur évite de transporter huit mégaoctets pour en garder
 * cinquante kilos.
 *
 * La borne est tenue par abaissement progressif de la qualité, jamais par un
 * refus sec : une photo de téléphone la dépasse toujours du premier coup, et
 * l'utilisateur n'a aucun moyen de savoir de combien.
 */

export const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

/** Au-delà, on refuse avant même de décoder : c'est déjà une erreur de dépôt. */
export const MAX_INPUT_BYTES = 8 * 1024 * 1024;

const INITIAL_QUALITY = 0.85;
const MIN_QUALITY = 0.3;
const QUALITY_STEP = 0.15;

function loadImage(file: File): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
            URL.revokeObjectURL(url);
            resolve(img);
        };
        img.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error('Image illisible'));
        };
        img.src = url;
    });
}

/**
 * Rend une URL de données JPEG tenant sous `maxLength`. Lève une `Error` au
 * message déjà lisible : c'est celui que l'utilisateur verra.
 */
export async function fileToSquareDataUrl(
    file: File,
    { size, maxLength }: { size: number; maxLength: number }
): Promise<string> {
    if (!ACCEPTED_TYPES.includes(file.type)) {
        throw new Error('Format non supporté (PNG, JPEG ou WebP).');
    }
    if (file.size > MAX_INPUT_BYTES) {
        throw new Error('Image trop volumineuse (8 Mo max).');
    }

    const img = await loadImage(file);
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Impossible de traiter l’image.');

    // Recadrage centré vers un carré, puis mise à l'échelle dans la cible.
    const side = Math.min(img.width, img.height);
    const sx = (img.width - side) / 2;
    const sy = (img.height - side) / 2;
    ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);

    let quality = INITIAL_QUALITY;
    let dataUrl = canvas.toDataURL('image/jpeg', quality);
    while (dataUrl.length > maxLength && quality > MIN_QUALITY) {
        quality -= QUALITY_STEP;
        dataUrl = canvas.toDataURL('image/jpeg', quality);
    }
    if (dataUrl.length > maxLength) {
        throw new Error('Image trop lourde après compression.');
    }
    return dataUrl;
}
