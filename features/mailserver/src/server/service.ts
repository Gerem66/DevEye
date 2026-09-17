import type { FeatureService, FeatureServiceDeps } from '@deveye/types/sdk/server';

import { setEngine } from './_shared';
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
        publicRoutes: (app) => engine.publicRoutes(app)
    };
}
