import { WsError } from '@/api/ws';
import { ensureUnlocked as ensureSecrecyUnlocked, touchSecrecy } from '@/stores/secrecy';

/**
 * Exécute une requête qui touche l'historique chiffré et, si la couche de
 * chiffrement par mot de passe répond `locked`, ouvre l'invite globale puis
 * réessaie une fois. Même motif que Notes et Password.
 *
 * Seules les commandes d'**historique** en ont besoin : `osint.probe` ne touche
 * rien de chiffré, ce qui est délibéré — sonder un domaine ne doit jamais
 * réclamer un mot de passe.
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

/** Transforme un échec WS en message court, pour un bandeau d'erreur. */
export function humanizeError(e: unknown, fallback: string): string {
    if (e instanceof WsError) {
        if (e.code === 'locked') return 'Déverrouillage requis.';
        if (e.code === 'forbidden') return 'Accès refusé.';
        if (e.code === 'validation') return e.message;
        if (e.code === 'timeout') return 'Délai dépassé.';
    }
    return fallback;
}

/**
 * Les liens internes que les sondes émettent (`osint:domain/example.com`).
 *
 * Une sonde ne connaît pas le client : elle ne peut pas fabriquer un
 * gestionnaire de clic. Elle émet donc une pseudo-URL, que la carte reconnaît
 * ici pour en faire un rebond vers une nouvelle recherche plutôt qu'un lien
 * sortant mort. C'est ce qui rend les adresses d'un DNS et les noms d'un
 * certificat directement cliquables.
 */
export function internalPivot(href: string): string | null {
    if (!href.startsWith('osint:')) return null;
    const slash = href.indexOf('/');
    if (slash === -1) return null;
    return href.slice(slash + 1);
}
