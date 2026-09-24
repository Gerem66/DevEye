import type { FeatureService, FeatureServiceDeps } from '@deveye/types/sdk/server';

import { env } from './env';
import type { DevicesRepo } from './repo';

/** Une fois par heure. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Le balayage de rétention : efface l'historique passé la conservation de
 * chaque appareil (`devices.retention_days`, à défaut
 * `MONITORING_RETENTION_DAYS`). Une seule échéance pour les trois tables, pour
 * qu'un instant ne soit jamais à moitié expiré ; les instants épinglés y
 * échappent, les appareils archivés sont figés. Purge globale, sans session ;
 * rien à diffuser, une frise se relit d'elle-même.
 */
export class RetentionSweep {
    private readonly ticker: FeatureService;
    private first: Promise<void> = Promise.resolve();

    constructor(private readonly deps: FeatureServiceDeps<DevicesRepo>) {
        this.ticker = deps.createTicker({ intervalMs: SWEEP_INTERVAL_MS, tick: () => this.sweep() });
    }

    start(): void {
        this.ticker.start();
        // Un serveur resté longtemps éteint n'attend pas une heure pour purger.
        this.first = this.sweep();
    }

    async stop(): Promise<void> {
        await Promise.all([this.ticker.stop(), this.first]);
    }

    /** Never throws: the ticker's guard would log it, the boot-time pass has none. */
    async sweep(): Promise<void> {
        try {
            const days = env.MONITORING_RETENTION_DAYS;
            const [metrics, presence, processes] = await Promise.all([
                this.deps.repo.metrics.pruneByRetention(days),
                this.deps.repo.presence.pruneByRetention(days),
                this.deps.repo.processSamples.pruneByRetention(days)
            ]);
            if (metrics + presence + processes > 0) {
                this.deps.logger.info({ metrics, presence, processes }, 'Pruned old monitoring history');
            }
        } catch (e) {
            this.deps.logger.error({ err: e instanceof Error ? e.message : String(e) }, 'Retention sweep failed');
        }
    }
}
