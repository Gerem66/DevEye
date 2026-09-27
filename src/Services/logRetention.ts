import type { Logger } from 'pino';
import type { FeatureService } from '@deveye/types/sdk/server';

import type { Database } from '@/db';

/**
 * La durée promise par la politique de confidentialité (« journaux de
 * connexion et d'accès : douze mois au plus ») : la changer ici, c'est changer
 * ce que dit le site.
 */
export const LOG_RETENTION_DAYS = 365;

const DAY_MS = 24 * 3600 * 1000;
/** Par lots : un seul DELETE sur une table de plusieurs millions de lignes la verrouillerait longtemps. */
const BATCH = 5000;

/** Supprime le journal d'audit au-delà de la durée de conservation, et dit combien de lignes sont parties. */
export async function purgeExpiredLogs(db: Pick<Database, 'logs'>, now: number): Promise<number> {
    const cutoff = Math.floor(now / 1000) - LOG_RETENTION_DAYS * 24 * 3600;
    let total = 0;
    for (;;) {
        const removed = await db.logs.purgeBefore(cutoff, BATCH);
        total += removed;
        if (removed < BATCH) return total;
    }
}

/** Une passe au démarrage, puis une par jour. */
export function createLogRetention(host: { db: Database; logger: Logger }): FeatureService {
    let timer: ReturnType<typeof setInterval> | null = null;
    let running = false;

    const run = async (): Promise<void> => {
        if (running) return;
        running = true;
        try {
            const removed = await purgeExpiredLogs(host.db, Date.now());
            if (removed > 0) host.logger.info({ removed, days: LOG_RETENTION_DAYS }, 'Expired audit logs purged');
        } catch (e) {
            host.logger.error({ err: e }, 'Audit log purge failed');
        } finally {
            running = false;
        }
    };

    return {
        start: () => {
            if (timer) return;
            void run();
            timer = setInterval(() => void run(), DAY_MS);
            timer.unref();
        },
        stop: () => {
            if (timer) clearInterval(timer);
            timer = null;
        }
    };
}
