import type { FeatureService, FeatureServiceDeps } from '@deveye/types/sdk/server';

import { env } from './env';
import type { DevicesRepo } from './repo';

/** Une fois par heure. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Une liste de processus complète le reste deux jours, le temps d'enquêter sur
 * un incident récent ; au-delà, un instant se relit pour ses gros
 * consommateurs. Le même top que l'agent en capture « top » (`TOP_PROCESS_LIMIT`,
 * `agent/src/report.rs`) : environ cinq fois moins d'octets par instant.
 */
const FULL_PROCESS_LIST_MS = 48 * 60 * 60 * 1000;
const TOP_PROCESSES = 20;
/** Par passe, en lots : une heure d'ingestion se rattrape largement, un retard en quelques passes. */
const THIN_BATCH = 200;
const THIN_BATCHES_PER_SWEEP = 100;

/**
 * Le balayage de rétention : efface l'historique passé la conservation de
 * chaque appareil (`devices.retention_days`, à défaut
 * `MONITORING_RETENTION_DAYS`). Une seule échéance pour les trois tables, pour
 * qu'un instant ne soit jamais à moitié expiré ; les instants épinglés y
 * échappent, les appareils archivés sont figés. Puis il réduit au top les
 * listes de processus de plus de deux jours, instants épinglés exceptés.
 * Global, sans session ; rien à diffuser, une frise se relit d'elle-même.
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
            let thinned = 0;
            for (let batch = 0; batch < THIN_BATCHES_PER_SWEEP; batch++) {
                const cut = await this.deps.repo.processSamples.thinBefore(
                    Date.now() - FULL_PROCESS_LIST_MS,
                    TOP_PROCESSES,
                    THIN_BATCH
                );
                thinned += cut;
                if (cut < THIN_BATCH) break;
            }
            if (thinned > 0) this.deps.logger.info({ thinned }, 'Cut old process lists down to their top');
        } catch (e) {
            this.deps.logger.error({ err: e instanceof Error ? e.message : String(e) }, 'Retention sweep failed');
        }
    }
}
