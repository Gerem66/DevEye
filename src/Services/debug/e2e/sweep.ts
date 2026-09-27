import type { Logger } from 'pino';

import type { Database } from '@/db';
import { moduleE2eEntries } from '@/features/_sdk/register';
import type { LiveHub } from '@/live/hub';
import { removeTestAccount, type Remover } from './accounts';
import { instanceTag, TEST_MAIL_DOMAIN } from './identity';

/** Un essai ne dure jamais autant : un compte d'essai plus vieux a été oublié par un serveur, quel qu'il soit. */
const STALE_MS = 3600_000;
/** Jusqu'où relire les journaux d'un compte d'essai disparu : le premier démarrage après un plantage suffit à les rattraper. */
const LOGS_LOOKBACK_MS = 7 * 24 * 3600_000;

export interface SweepDeps {
    db: Database;
    live: LiveHub;
    logger: Pick<Logger, 'warn'>;
}

/** Les comptes d'essai à supprimer : ceux de ce serveur, et ceux de tout serveur qui les a oubliés. */
async function leftovers(db: Database): Promise<{ id: number; email: string }[]> {
    const own = `${instanceTag()}-`;
    const now = Date.now();
    return (await db.debug.testAccounts()).filter((a) => a.run.startsWith(own) || now - a.created * 1000 > STALE_MS);
}

export async function countResidue(db: Database): Promise<number> {
    return (await leftovers(db)).length;
}

/**
 * Supprime ce que des essais ont laissé : jamais pendant un essai de ce
 * serveur (l'appelant tient le verrou), et jamais le compte en cours d'un
 * essai d'un autre serveur, trop jeune pour être un oubli. Rend le nombre de
 * comptes supprimés et ce qui a résisté, journalisé et laissé au suivant.
 */
export async function sweepTestResidue(
    { db, live, logger }: SweepDeps,
    by: Remover
): Promise<{ removed: number; failures: string[] }> {
    let removed = 0;
    const failures: string[] = [];
    for (const account of await leftovers(db)) {
        try {
            await removeTestAccount({ db, live }, { userId: account.id, email: account.email }, by);
            removed++;
        } catch (e) {
            logger.warn({ err: e, userId: account.id }, 'Compte d’essai non supprimé');
            failures.push(`Compte ${account.email} : ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    await db.debug.purgeSignupsLike(`e2e-${instanceTag()}-%@${TEST_MAIL_DOMAIN}`);
    await db.debug.purgeOrphanLogsNaming(`e2e-${instanceTag()}-`, Math.floor((Date.now() - LOGS_LOOKBACK_MS) / 1000));
    for (const { featureId, label, entry } of moduleE2eEntries(db)) {
        if (!entry.sweep) continue;
        try {
            await entry.sweep();
        } catch (e) {
            logger.warn({ err: e, module: featureId }, 'Ménage d’essai d’un module en échec');
            failures.push(`${label} : ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    return { removed, failures };
}
