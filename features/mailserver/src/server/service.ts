import type { FeatureService, FeatureServiceDeps } from '@deveye/types/sdk/server';

import { ADDRESSES, getEngine, setEngine } from './_shared';
import { createEngine } from './engine/engine';
import type { MailserverRepo } from './repo';

/** Le service du module : il démarre le moteur et le tend aux commandes. */
export function createMailService(deps: FeatureServiceDeps<MailserverRepo>): FeatureService {
    const engine = createEngine(deps);
    return {
        async start() {
            await engine.start();
            setEngine(engine.handle);
        },
        async stop() {
            setEngine(null);
            await engine.stop();
        },
        publicRoutes: (app) => engine.publicRoutes(app),
        health: () => engine.health(),
        // Une session IMAP ouverte ne relit pas sa boîte : comme à l'extinction,
        // elle se ferme. La reprise n'a rien à rouvrir, le client se reconnecte.
        async onPlanPause(change) {
            if (change.key !== ADDRESSES) return;
            for (const item of change.paused) await getEngine()?.dropMailbox(Number(item.id), false);
        }
    };
}
