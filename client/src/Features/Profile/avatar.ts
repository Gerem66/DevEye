import { AVATAR_MAX_LENGTH } from '@deveye/types';
import { fileToSquareDataUrl } from '@/imageResize';

export { ACCEPTED_TYPES, MAX_INPUT_BYTES } from '@/imageResize';

/** Square output size (px) for the stored avatar thumbnail. */
const TARGET_SIZE = 256;

/**
 * Resize/center-crop an image file to a square JPEG data URL for
 * `user.setAvatar`. The resizing lives in `imageResize`, shared with the
 * project icon: same gesture, same contract bound.
 */
export function fileToAvatarDataUrl(file: File): Promise<string> {
    return fileToSquareDataUrl(file, { size: TARGET_SIZE, maxLength: AVATAR_MAX_LENGTH });
}

/** L'image d'un compte qui n'en a pas posé : celle que la base lui donne à la création. */
const DEFAULT_AVATAR = 'default-user.png';

/**
 * Ce qu'un `<img>` doit charger pour cet avatar : une URL de données telle
 * quelle, sinon un nom de fichier du dossier statique des images. Chemin absolu
 * exprès : la première session d'un compte neuf se dessine alors que l'adresse
 * est encore `/register/<jeton>`.
 */
export function avatarSrc(avatar: string): string {
    if (avatar.startsWith('data:') || avatar.startsWith('http')) return avatar;
    return `/images/${avatar || DEFAULT_AVATAR}`;
}
