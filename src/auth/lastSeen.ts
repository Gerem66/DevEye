import type { Database } from '@/db';
import { logger } from '@/logger';

/** La liste des membres compte en jours : une écriture par compte et par période suffit. */
const STEP_SECONDS = 5 * 60;

const written = new Map<number, number>();

/**
 * Le compte vient d'ouvrir ou d'utiliser l'application : le « vu » de la liste
 * des membres. Jamais au rafraîchissement des jetons, qu'un onglet oublié
 * déclenche seul.
 */
export async function markSeen(db: Database, userId: number): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    if (now - (written.get(userId) ?? 0) < STEP_SECONDS) return;
    try {
        await db.users.updateLastSeen(userId, now);
        written.set(userId, now);
    } catch (err) {
        logger.warn({ err, userId }, 'dernière visite : écriture impossible');
    }
}
