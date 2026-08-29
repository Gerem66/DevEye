import type { DatabaseRow } from '../contracts/domain';
import {
    DATABASE_BACKUP_PROVIDER,
    DATABASE_ITEMS_PROVIDER,
    type DatabaseBackupCandidate,
    type DatabaseBackupProvider,
    type DatabaseItemsProvider
} from '@deveye/types/sdk';
import type { FeatureServer, FeatureServiceDeps, SdkCipher } from '@deveye/types/sdk/server';

import { databaseHandlers } from './handlers';
import { createRepo, type DatabaseRepo } from './repo';
import { DatabaseMonitor } from './service';
import { openTunnel } from './tunnel';
import { readJson, setMonitor, type StoredDatabase } from './_shared';

/**
 * Ce que Sauvegardes demande (`DATABASE_BACKUP_PROVIDER`) : les bases nommées,
 * et un accès ouvert à l'une d'elles, tunnel compris, par le chemin de la
 * supervision (`DatabaseMonitor.targetOf`, seul endroit qui déchiffre une cible).
 */
function createBackupProvider(
    deps: FeatureServiceDeps<DatabaseRepo>,
    monitor: DatabaseMonitor
): DatabaseBackupProvider {
    const candidateOf = async (row: DatabaseRow, workspaceId: number): Promise<DatabaseBackupCandidate> => {
        // Un blob illisible ne retire pas la base du sélecteur : le run dira
        // ce qui cloche.
        const stored = (await readJson<Partial<StoredDatabase>>(deps.cipherFor(workspaceId), row.content)) ?? {};
        return {
            id: row.id,
            name: stored.name ?? `Base ${row.id}`,
            engine: row.engine === 'postgres' ? 'postgres' : 'mysql',
            host: stored.host ?? '?',
            database: stored.database ?? '?'
        };
    };

    return {
        async listDatabases(workspaceId) {
            const rows = await deps.repo.list(workspaceId);
            return Promise.all(rows.map((row) => candidateOf(row, workspaceId)));
        },
        async findDatabase(databaseId, workspaceId) {
            const row = await deps.repo.find(databaseId, workspaceId);
            return row ? candidateOf(row, workspaceId) : null;
        },
        async openAccess(databaseId, workspaceId) {
            const row = await deps.repo.find(databaseId, workspaceId);
            if (!row) return null;
            const target = await monitor.targetOf(row, workspaceId);
            const tunnel = await openTunnel(target.access, { host: target.host, port: target.port });
            return {
                engine: target.engine,
                host: tunnel.host,
                port: tunnel.port,
                database: target.database,
                username: target.username,
                password: target.password,
                close: tunnel.close
            };
        }
    };
}

/**
 * Le nom d'une base, déchiffré par le codec ouvert de son domicile ; `null`
 * (jamais une exception) si la base a disparu ou si le blob est illisible.
 */
async function labelOf(
    repo: DatabaseRepo,
    cipher: SdkCipher,
    databaseId: number,
    workspaceId: number
): Promise<string | null> {
    const row = await repo.find(databaseId, workspaceId);
    if (!row) return null;
    const stored = await readJson<Partial<StoredDatabase>>(cipher, row.content);
    return typeof stored?.name === 'string' && stored.name.length > 0 ? stored.name : null;
}

/**
 * L'entrée serveur du module : le relevé périodique (`DatabaseMonitor`), son
 * singleton pour les handlers, les contrats offerts à Sauvegardes et à Projets,
 * et `items` (domicile et nom d'une base) qu'exige `shareTier: 'open'`.
 *
 * Pas de `migrationsDir` : les tables du module datent du socle (allowlist dans
 * deveye-feature.json) ; une nouvelle table inaugurera `src/server/migrations/`
 * avec le préfixe `ft_database_`.
 */
export const serverEntry: FeatureServer<DatabaseRepo> = {
    createRepo,
    features: databaseHandlers,
    createService(deps) {
        const monitor = new DatabaseMonitor(deps);
        // Projets ne relie que ce que son espace possède (le domicile, jamais
        // une projection), pour qu'un identifiant étranger ne trahisse pas son
        // existence ; `labelOf` nomme une liaison qu'une fenêtre ne peut ouvrir.
        const items: DatabaseItemsProvider = {
            exists: async (databaseId, workspaceId) => (await deps.repo.find(databaseId, workspaceId)) !== null,
            labelOf: (databaseId, workspaceId) =>
                labelOf(deps.repo, deps.cipherFor(workspaceId), databaseId, workspaceId)
        };
        return {
            start() {
                setMonitor(monitor);
                monitor.start();
            },
            stop() {
                monitor.stop();
                setMonitor(null);
            },
            providers: {
                [DATABASE_BACKUP_PROVIDER]: createBackupProvider(deps, monitor),
                [DATABASE_ITEMS_PROVIDER]: items
            }
        };
    },
    items: {
        homeOf: async (repo, itemId, workspaceId) =>
            (await repo.findVisible(itemId, workspaceId))?.workspace_id ?? null,
        labelOf
    }
};
