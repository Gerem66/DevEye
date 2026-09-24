import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FeatureServer } from '@deveye/types/sdk/server';

import { backupHandlers } from './handlers';
import { createRepo, type BackupRepo } from './repo';
import { BackupEngine } from './service';
import { setEngine } from './_shared';
import { BACKUP_ENV } from './env';

/**
 * `items` : ce que le partage et les routes de notification savent des
 * travaux sans ouvrir la feature (domicile et nom, déchiffré par le codec
 * ouvert de l'espace appelant). `migrationsDir` : les tables datent du socle,
 * la séquence du module ne porte que ce qui les corrige.
 */
export const serverEntry: FeatureServer<BackupRepo> = {
    env: BACKUP_ENV,
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
    // Pas d'entrée `move`, et ce n'est pas un oubli : un travail ne peut pas
    // exister sans destination (`destination_id` NOT NULL), et sa destination
    // comme sa source sont des objets de l'espace qu'il quitterait. Déplacé, il
    // écrirait vers un magasin que son nouvel espace ne voit pas, sans qu'on
    // puisse même le laisser sans destination le temps d'en choisir une.
    items: {
        homeOf: async (repo, itemId, workspaceId) =>
            (await repo.findVisibleJob(Number(itemId), workspaceId))?.workspace_id ?? null,
        // Un blob illisible ou un travail disparu vaut `null` : « une cible
        // disparue » pour l'écran des canaux.
        labelOf: async (repo, cipher, itemId, workspaceId) => {
            const row = await repo.findJob(Number(itemId), workspaceId);
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
