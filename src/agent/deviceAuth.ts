import type { DeviceRow } from '@deveye/types';

import { verifyDeviceToken, type DeviceClaims } from '@/auth/jwt';
import type { Database } from '@/db';
import { sha256hex } from '@/Utils/hash';

export interface AuthenticatedDevice {
    device: DeviceRow;
    claims: DeviceClaims;
    /**
     * Quel jeton a été présenté : le courant, ou celui qu'une rotation est en
     * train de remplacer (l'agent n'a pas encore reçu, ou pas encore enregistré,
     * le nouveau).
     */
    presented: 'current' | 'previous';
}

/**
 * L'authentification d'un appareil par son jeton, pour la socket `/agent` et
 * pour le téléchargement de sa mise à jour. `null` pour toute cause (jeton
 * invalide ou expiré, appareil inconnu, condensé qui ne correspond à rien) :
 * l'appelant répond de la même façon, une sonde n'apprend rien. Le statut
 * (révoqué, archivé) reste à l'appelant, qui n'en fait pas la même chose.
 */
export async function authenticateDevice(db: Database, token: string): Promise<AuthenticatedDevice | null> {
    const claims = await verifyDeviceToken(token);
    if (!claims) return null;
    const device = await db.devices.findById(claims.sub);
    if (!device || !device.token_hash) return null;
    const hash = sha256hex(token);
    if (device.token_hash === hash) return { device, claims, presented: 'current' };
    if (device.token_hash_prev && device.token_hash_prev === hash) return { device, claims, presented: 'previous' };
    return null;
}

/**
 * Le jeton que porte la requête. L'en-tête d'abord : c'est ce qu'envoie un agent
 * à jour, et une URL finit dans les journaux de chaque proxy traversé. La forme
 * `?token=` reste lue parce qu'un agent plus ancien n'en connaît pas d'autre et
 * ne peut recevoir l'ordre de se mettre à jour que par cette même socket.
 */
export function deviceTokenOf(req: { headers: Record<string, unknown>; query: unknown }): {
    token: string;
    fromQuery: boolean;
} | null {
    const auth = req.headers['authorization'];
    if (typeof auth === 'string' && auth.startsWith('Bearer ')) return { token: auth.slice(7), fromQuery: false };
    const q = req.query as { token?: unknown } | undefined;
    if (q && typeof q.token === 'string') return { token: q.token, fromQuery: true };
    return null;
}
