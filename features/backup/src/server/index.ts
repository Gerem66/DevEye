import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FeatureServer } from '@deveye/types/sdk/server';

import { backupHandlers } from './handlers';
import { createRepo, type BackupRepo } from './repo';
import { BackupEngine } from './service';
import { setEngine } from './_shared';

/**
 * `items` : ce que le partage et les routes de notification savent des
 * travaux sans ouvrir la feature (domicile et nom, déchiffré par le codec
 * ouvert de l'espace appelant). `migrationsDir` : les tables datent du socle,
 * la séquence du module ne porte que ce qui les corrige.
 */
export const serverEntry: FeatureServer<BackupRepo> = {
    createRepo,
    features: backupHandlers,
    migrationsDir: path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations'),
    createService(deps) {
        const engine = new BackupEngine(deps);
        return {
            start() {
                setEngine(engine);
                engine.start();
            },
            stop() {
                engine.stop();
                setEngine(null);
            }
        };
    },
    items: {
        homeOf: async (repo, itemId, workspaceId) =>
            (await repo.findVisibleJob(itemId, workspaceId))?.workspace_id ?? null,
        // Un blob illisible ou un travail disparu vaut `null` : « une cible
        // disparue » pour l'écran des canaux.
        labelOf: async (repo, cipher, itemId, workspaceId) => {
            const row = await repo.findJob(itemId, workspaceId);
            if (!row) return null;
            const plain = await cipher.tryDecrypt(row.content);
            if (plain === null) return null;
            try {
                const parsed = JSON.parse(plain) as { name?: unknown };
                return typeof parsed.name === 'string' && parsed.name.length > 0 ? parsed.name : null;
            } catch {
                return null;
            }
        }
    }
};
