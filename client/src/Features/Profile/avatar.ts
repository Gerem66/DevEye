import { AVATAR_MAX_LENGTH } from 'deveye-types';

/** Square output size (px) for the stored avatar thumbnail. */
const TARGET_SIZE = 256;
/** Initial JPEG quality; lowered on retry if the data URL is too large. */
const INITIAL_QUALITY = 0.85;

export const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
export const MAX_INPUT_BYTES = 8 * 1024 * 1024; // 8 MB before resizing

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
 * Resize/center-crop an image file to a square JPEG data URL suitable for the
 * `user.setAvatar` command. Retries at lower quality until it fits within
 * `AVATAR_MAX_LENGTH`.
 */
export async function fileToAvatarDataUrl(file: File): Promise<string> {
    if (!ACCEPTED_TYPES.includes(file.type)) {
        throw new Error('Format non supporté (PNG, JPEG ou WebP).');
    }
    if (file.size > MAX_INPUT_BYTES) {
        throw new Error('Image trop volumineuse (8 Mo max).');
    }

    const img = await loadImage(file);
    const canvas = document.createElement('canvas');
    canvas.width = TARGET_SIZE;
    canvas.height = TARGET_SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error("Impossible de traiter l'image.");

    // Center-crop the source to a square, then scale into the target canvas.
    const side = Math.min(img.width, img.height);
    const sx = (img.width - side) / 2;
    const sy = (img.height - side) / 2;
    ctx.drawImage(img, sx, sy, side, side, 0, 0, TARGET_SIZE, TARGET_SIZE);

    let quality = INITIAL_QUALITY;
    let dataUrl = canvas.toDataURL('image/jpeg', quality);
    while (dataUrl.length > AVATAR_MAX_LENGTH && quality > 0.3) {
        quality -= 0.15;
        dataUrl = canvas.toDataURL('image/jpeg', quality);
    }
    if (dataUrl.length > AVATAR_MAX_LENGTH) {
        throw new Error('Image trop lourde après compression.');
    }
    return dataUrl;
}

/**
 * Resolve an avatar value to an <img> src. Uploaded avatars are data URLs used
 * as-is; legacy filename values resolve against the static images directory.
 */
export function avatarSrc(avatar: string): string {
    if (!avatar) return './images/default-user.png';
    if (avatar.startsWith('data:') || avatar.startsWith('http')) return avatar;
    return `./images/${avatar}`;
}
