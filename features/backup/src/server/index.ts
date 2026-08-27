import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FeatureServer } from '@deveye/types/sdk/server';

import { backupHandlers } from './handlers';
import { createRepo, type BackupRepo } from './repo';
import { BackupEngine } from './service';
import { setEngine } from './_shared';

/**
 * L'entrée serveur du module.
 *
 * `createService` recompose ce que le boot natif faisait : l'ordonnanceur
 * (`BackupEngine`, l'ex `BackupService`) démarré après le solde des exécutions
 * restées « en cours », et le singleton posé pour les handlers
 * (`backup.destinationTest`, `backup.jobRun`, `backup.jobRemove`), patron
 * `setEngine` de CloudSync.
 *
 * `items` est ce que le partage et les routes de notification savent des
 * travaux sans ouvrir la feature : le domicile d'un travail visible d'ici (le
 * sien, ou l'espace qui le projette), et son nom, déchiffré par le codec
 * ouvert de l'espace appelant. `shareTier: 'open'` l'exige.
 *
 * `migrationsDir` : les trois tables datent du socle (086 et 094, jamais
 * déplacées, allowlist dans deveye-feature.json) ; la séquence du module ne
 * porte que ce qui les corrige (`001`, la cascade des travaux).
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
        // Le nom est la seule clé du blob chiffré à l'étage ouvert ; un blob
        // illisible ou un travail disparu vaut `null`, ce que l'écran des canaux
        // montre comme « une cible disparue ».
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
