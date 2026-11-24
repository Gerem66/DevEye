import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
import {
    rekeyTreeDigests,
    type FeatureServer,
    type FeatureServiceDeps,
    type SdkCipher
} from '@deveye/types/sdk/server';

import { databaseAccountExport } from './accountExport';
import { assertReadOnly, explainError, openSession, singleNumber } from './engine';
import { databaseHandlers } from './handlers';
import { databaseCopy, databaseTree } from './copy';
import { databaseE2e } from './e2e';
import { databaseMove } from './move';
import { createRepo, type DatabaseRepo } from './repo';
import { DatabaseMonitor } from './service';
import { openTunnel } from './tunnel';
import { PLAN_PAUSED_MESSAGE, readJson, setMonitor, type StoredDatabase } from './_shared';

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
            // Pas de garde de pause ici : une sauvegarde est un travail de
            // Sauvegardes, que borne son propre stockage, pas le suivi des bases.
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
        },
        // Un vidage livre toutes les lignes : le droit d'explorer la base, qui
        // est l'écriture ici, surcharge de l'élément comprise.
        authorize: (databaseId, workspaceId, userId) =>
            deps.access.feature(workspaceId, userId, { level: 'write', itemId: String(databaseId) })
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
            if (deps.pauses.isPaused('connections', String(row.id))) {
                return queries.map(() => ({ value: null, error: PLAN_PAUSED_MESSAGE }));
            }
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
        },
        // Une mesure lit n'importe quelle table : le droit d'explorer la base.
        authorize: (databaseId, workspaceId, userId) =>
            deps.access.feature(workspaceId, userId, { level: 'write', itemId: String(databaseId) })
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
 * Les tables du module datent du socle (allowlist dans deveye-feature.json) :
 * ses migrations ne font que les modifier, et une nouvelle table prendra le
 * préfixe `ft_database_`.
 */
export const serverEntry: FeatureServer<DatabaseRepo> = {
    createRepo,
    migrationsDir: path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations'),
    dataSteps: [
        {
            // Le condensé du nom passe d'un SHA-256 nu à `keys.ref`, lié à l'espace.
            id: '001-keyed-refs',
            async run({ q, cipherFor, keys, logger }) {
                const pass = await rekeyTreeDigests(q, databaseTree, { cipherFor, keys });
                // Une fiche illisible ne peut plus tenir son nom : il redevient libre dans son espace.
                if (pass.unreadable > 0 || pass.duplicates > 0) {
                    logger.error(
                        { unreadable: pass.unreadable, duplicates: pass.duplicates },
                        'Bases : des fiches illisibles ou en double ont perdu leur nom unique'
                    );
                }
            }
        }
    ],
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
            },
            listHome: async (workspaceIds) =>
                Promise.all(
                    (await deps.repo.listHome(workspaceIds)).map(async (row) => {
                        const ws = Number(row.workspace_id);
                        const stored = await readJson<Partial<StoredDatabase>>(deps.cipherFor(ws), row.content);
                        return {
                            id: Number(row.id),
                            workspaceId: ws,
                            name: typeof stored?.name === 'string' && stored.name ? stored.name : `Base ${row.id}`,
                            engine: row.engine === 'postgres' ? ('postgres' as const) : ('mysql' as const),
                            serverVersion: row.server_version,
                            checkedAt: row.last_check_at === null ? null : Number(row.last_check_at),
                            paused: deps.pauses.isPaused('connections', String(row.id))
                        };
                    })
                ),
            authorize: async (databaseId, workspaceId, userId) => {
                if (!(await deps.repo.findVisible(databaseId, workspaceId))) return { ok: false, reason: 'hidden' };
                return deps.access.feature(workspaceId, userId, { level: 'read', itemId: String(databaseId) });
            }
        };
        return {
            start() {
                setMonitor(monitor);
                monitor.start();
            },
            async stop() {
                await monitor.stop();
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
        move: databaseMove,
        copy: databaseCopy
    },
    quotas: { connections: { list: (repo, owned) => repo.listStock(owned) } },
    accountExport: databaseAccountExport,
    e2e: databaseE2e
};
