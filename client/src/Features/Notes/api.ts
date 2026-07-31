import { WsError } from '@/api/ws';
import { ensureUnlocked as ensureSecrecyUnlocked, touchSecrecy } from '@/stores/secrecy';

/**
 * Run a request that touches a private note and, if the password-encryption
 * layer reports `locked`, open the global unlock prompt and retry once. Mirrors
 * the Password feature. Listing and folder management never need this: they only
 * use the open key, which is why the feature opens without any prompt.
 */
export async function withSecrecy<T>(run: () => Promise<T>): Promise<T> {
    try {
        const out = await run();
        touchSecrecy();
        return out;
    } catch (e) {
        if (e instanceof WsError && e.code === 'locked') {
            await ensureSecrecyUnlocked();
            const out = await run();
            touchSecrecy();
            return out;
        }
        throw e;
    }
}

/** Turn a WS failure into a short French message for an inline error banner. */
export function humanizeError(e: unknown, fallback: string): string {
    if (e instanceof WsError) {
        if (e.code === 'locked') return 'Déverrouillage requis.';
        if (e.code === 'forbidden') return 'Accès refusé.';
    }
    return fallback;
}
