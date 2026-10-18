import type { FeatureService, FeatureServiceDeps } from '@deveye/types/sdk/server';

import { OSINT_HISTORY_DAYS } from '../contracts/domain';
import type { OsintRepo } from './repo';

const DAY_S = 24 * 3600;

/** La purge de l'historique au-delà de `OSINT_HISTORY_DAYS` : une passe au démarrage, puis une par jour. */
export function createService(deps: FeatureServiceDeps<OsintRepo>): FeatureService {
    const purge = async (): Promise<void> => {
        const cutoff = Math.floor(Date.now() / 1000) - OSINT_HISTORY_DAYS * DAY_S;
        const removed = await deps.repo.purgeLookupsBefore(cutoff);
        if (removed > 0)
            deps.logger.info({ removed, days: OSINT_HISTORY_DAYS }, 'osint: anciennes recherches effacées');
    };
    const ticker = deps.createTicker({ intervalMs: DAY_S * 1000, tick: purge });
    let first: Promise<void> = Promise.resolve();

    return {
        async start() {
            await ticker.start();
            // Le premier tour du ticker attend un jour : un serveur redéployé plus souvent ne purgerait jamais.
            first = purge().catch((e: unknown) =>
                deps.logger.error({ err: e }, 'osint: purge de l’historique en échec')
            );
        },
        async stop() {
            await Promise.all([ticker.stop(), first]);
        }
    };
}
