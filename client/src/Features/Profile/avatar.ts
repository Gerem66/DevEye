import { AVATAR_MAX_LENGTH } from '@deveye/types';
import { fileToSquareDataUrl } from '@/imageResize';

export { ACCEPTED_TYPES, MAX_INPUT_BYTES } from '@/imageResize';

/** Square output size (px) for the stored avatar thumbnail. */
const TARGET_SIZE = 256;

/**
 * Resize/center-crop an image file to a square JPEG data URL suitable for the
 * `user.setAvatar` command.
 *
 * The resizing itself lives in {@link ../../imageResize}, shared with the
 * project icon: same gesture, same constraint (stay under a contract bound),
 * and one implementation is one place to fix a quality bug.
 */
export function fileToAvatarDataUrl(file: File): Promise<string> {
    return fileToSquareDataUrl(file, { size: TARGET_SIZE, maxLength: AVATAR_MAX_LENGTH });
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
