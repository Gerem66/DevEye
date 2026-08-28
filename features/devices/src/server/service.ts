import type { FeatureService, FeatureServiceDeps } from '@deveye/types/sdk/server';

import { env } from './env';
import type { DevicesRepo } from './repo';

/** Une fois par heure : la cadence que le boot natif tenait dans `index.ts`. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Le balayage de rétention : efface l'historique passé la conservation de
 * chaque appareil (`devices.retention_days`, à défaut
 * `MONITORING_RETENTION_DAYS`). Une seule échéance pour les trois tables
 * (métriques, présence, processus), pour qu'un instant ne soit jamais à
 * moitié expiré ; les instants épinglés y échappent, et les appareils
 * archivés sont figés (leur historique ne bouge plus). Un passage au
 * démarrage, puis toutes les heures, sur un ticker du SDK.
 *
 * Sans session, sans espace : la purge est globale, comme l'ingestion qui
 * remplit ces tables. Rien à diffuser non plus : une frise qui perd ses
 * points les plus anciens se relit d'elle-même à la prochaine fenêtre.
 */
export class RetentionSweep {
    private readonly ticker: FeatureService;

    constructor(private readonly deps: FeatureServiceDeps<DevicesRepo>) {
        this.ticker = deps.createTicker({ intervalMs: SWEEP_INTERVAL_MS, tick: () => this.sweep() });
    }

    start(): void {
        this.ticker.start();
        // Un premier passage tout de suite : un serveur resté longtemps éteint
        // n'attend pas une heure pour rattraper sa purge.
        void this.sweep();
    }

    stop(): void {
        this.ticker.stop();
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
