import { MAILSERVER_BACKUP_PROVIDER } from '@deveye/types/sdk';
import type { FeatureService, FeatureServiceDeps } from '@deveye/types/sdk/server';

import { ADDRESSES, getEngine, setEngine } from './_shared';
import { createBackupProvider } from './backupSource';
import { diskBlobStore } from './engine/blobs';
import { createEngine } from './engine/engine';
import { env } from './env';
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
        providers: {
            [MAILSERVER_BACKUP_PROVIDER]: createBackupProvider(deps, diskBlobStore(env.MAILSERVER_STORAGE_DIR))
        },
        health: () => engine.health(),
        // Une session IMAP ouverte ne relit pas sa boîte : comme à l'extinction,
        // elle se ferme. La reprise n'a rien à rouvrir, le client se reconnecte.
        async onPlanPause(change) {
            if (change.key !== ADDRESSES) return;
            for (const item of change.paused) await getEngine()?.dropMailbox(Number(item.id), false);
        }
    };
}
