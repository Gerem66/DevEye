import type { DatabaseRow } from '../contracts/domain';
import {
    DATABASE_BACKUP_PROVIDER,
    DATABASE_ITEMS_PROVIDER,
    DATABASE_MEASURE_PROVIDER,
    type DatabaseBackupCandidate,
    type DatabaseBackupProvider,
    type DatabaseItemsProvider,
    type DatabaseMeasureProvider,
    type DatabaseNumberOutcome
} from '@deveye/types/sdk';
import type { FeatureServer, FeatureServiceDeps, SdkCipher } from '@deveye/types/sdk/server';

import { assertReadOnly, explainError, openSession, singleNumber } from './engine';
import { databaseHandlers } from './handlers';
import { databaseMove } from './move';
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
 * Ce que Projets demande (`DATABASE_MEASURE_PROVIDER`) : un nombre par requête,
 * dans une seule session. Le tunnel se paie une fois pour toutes les requêtes
 * d'une même base, et une requête fautive rend son erreur sans interrompre les
 * autres, comme les conditions d'une alerte.
 */
function createMeasureProvider(
    deps: FeatureServiceDeps<DatabaseRepo>,
    monitor: DatabaseMonitor
): DatabaseMeasureProvider {
    return {
        async measure(databaseId, workspaceId, queries) {
            const row = await deps.repo.findVisible(databaseId, workspaceId);
            if (!row) return null;
            if (queries.length === 0) return [];
            // Le codec du DOMICILE : le secret d'une base projetée est scellé
            // sous la clé de son espace, pas sous celle d'où on la regarde.
            const session = await openSession(await monitor.targetOf(row, row.workspace_id));
            try {
                const out: DatabaseNumberOutcome[] = [];
                for (const sql of queries) {
                    try {
                        // Deux fois plutôt qu'une : une chaîne stockée ne se
                        // fait pas confiance, quoi qu'ait accepté le formulaire.
                        assertReadOnly(sql);
                        out.push({ value: singleNumber(await session.query(sql)), error: null });
                    } catch (e) {
                        out.push({ value: null, error: explainError(e) });
                    }
                }
                return out;
            } finally {
                try {
                    await session.close();
                } catch {
                    /* la fermeture d'une session déjà morte n'a rien à dire */
                }
            }
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
        // Projets ne relie que ce que son espace voit, chez lui ou projeté, pour
        // qu'un identifiant invisible d'ici ne trahisse pas son existence ;
        // `labelOf` nomme sous le codec du domicile, seul à savoir l'ouvrir.
        const items: DatabaseItemsProvider = {
            exists: async (databaseId, workspaceId) => (await deps.repo.findVisible(databaseId, workspaceId)) !== null,
            labelOf: async (databaseId, workspaceId) => {
                const row = await deps.repo.findVisible(databaseId, workspaceId);
                return row ? labelOf(deps.repo, deps.cipherFor(row.workspace_id), databaseId, row.workspace_id) : null;
            }
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
                [DATABASE_MEASURE_PROVIDER]: createMeasureProvider(deps, monitor),
                [DATABASE_ITEMS_PROVIDER]: items
            }
        };
    },
    items: {
        homeOf: async (repo, itemId, workspaceId) =>
            (await repo.findVisible(Number(itemId), workspaceId))?.workspace_id ?? null,
        labelOf: (repo, cipher, itemId, workspaceId) => labelOf(repo, cipher, Number(itemId), workspaceId),
        move: databaseMove
    }
};
