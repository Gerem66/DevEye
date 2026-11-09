import { useResource } from 'deveye-sdk-client';

import type { SavedSignature, StoredSignature } from '../../contracts/signatures';
import { api } from '../api';
import { addAsset, assetBytes } from './documents';
import type { SignatureData } from './elements';

/**
 * Les signatures gardées sur le compte : la forme stockée porte l'image
 * elle-même (en base64), là où l'atelier ne tient qu'une référence à des
 * octets en mémoire.
 */

const CHUNK = 0x8000;

function toBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

/** Ce qu'on envoie garder ; `null` quand l'image n'est plus en mémoire. */
export function toStored(data: SignatureData): StoredSignature | null {
    if (data.kind !== 'image') return data;
    const bytes = assetBytes(data.assetId);
    if (!bytes) return null;
    return { kind: 'image', png: toBase64(bytes), width: data.width, height: data.height };
}

/** Une signature gardée, prête à être posée : son image rejoint les octets de l'atelier. */
export function fromStored(stored: StoredSignature): SignatureData {
    if (stored.kind !== 'image') return stored;
    return {
        kind: 'image',
        assetId: addAsset(fromBase64(stored.png), 'image/png'),
        width: stored.width,
        height: stored.height
    };
}

/** L'image d'une signature gardée, pour la montrer dans la liste. */
export const storedImageUrl = (stored: Extract<StoredSignature, { kind: 'image' }>): string =>
    `data:image/png;base64,${stored.png}`;

export function useSavedSignatures(): {
    signatures: readonly SavedSignature[] | null;
    error: ReturnType<typeof useResource>['error'];
} {
    const { data, error } = useResource(
        'convert.signatures',
        () => api.send('convert.signatures', {}).then((r) => r.signatures),
        'Impossible de charger vos signatures gardées.'
    );
    return { signatures: data, error };
}
