import type { DatabaseRow } from '../contracts/domain';
import {
    DATABASE_BACKUP_PROVIDER,
    DATABASE_ITEMS_PROVIDER,
    type DatabaseBackupCandidate,
    type DatabaseBackupProvider,
    type DatabaseItemsProvider
} from '@deveye/types/sdk';
import type { FeatureServer, FeatureServiceDeps } from '@deveye/types/sdk/server';

import { databaseHandlers } from './handlers';
import { createRepo, type DatabaseRepo } from './repo';
import { DatabaseMonitor } from './service';
import { openTunnel } from './tunnel';
import { readJson, setMonitor, type StoredDatabase } from './_shared';

/**
 * Ce que le module Sauvegardes demande à Bases de données
 * (`DATABASE_BACKUP_PROVIDER`) : ses bases nommées (le nom vit chiffré sous le
 * codec de l'espace, que seule cette feature relit), et un ACCÈS ouvert à l'une
 * d'elles, tunnel SSH ou proxy SOCKS compris, exactement le chemin que la
 * supervision emprunte (`DatabaseMonitor.targetOf`, seul endroit qui déchiffre
 * une connexion).
 *
 * L'app l'offrait tant que la feature était native ; c'est désormais le
 * service du module qui publie la même clé, et Sauvegardes n'y a vu aucune
 * différence. Le codec ouvert est celui du SDK (`deps.cipherFor`, mémoïsé par
 * espace : la clé de l'espace se résout une fois, pas à chaque ligne listée).
 */
function createBackupProvider(
    deps: FeatureServiceDeps<DatabaseRepo>,
    monitor: DatabaseMonitor
): DatabaseBackupProvider {
    const candidateOf = async (row: DatabaseRow, workspaceId: number): Promise<DatabaseBackupCandidate> => {
        // Un blob illisible ne retire pas la base du sélecteur : elle existe,
        // et le run dira ce qui cloche s'il faut la vider.
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
 * L'entrée serveur du module.
 *
 * `createService` recompose ce que le boot natif faisait : le relevé
 * périodique (`DatabaseMonitor`, l'ex `Services/DatabaseMonitor.ts`) démarré
 * avec les autres services, le singleton posé pour les handlers
 * (`database.inspect`, et toute commande qui ouvre une session : c'est lui
 * qui déchiffre une cible), et les deux contrats offerts : à Sauvegardes
 * (`DATABASE_BACKUP_PROVIDER`, qu'`app.ts` enregistrait pour la native) et à
 * Projets (`DATABASE_ITEMS_PROVIDER` : une base existe-t-elle dans cet
 * espace ?).
 *
 * Bases de données a **ses propres** canaux (`notification_settings`, ligne
 * `database`), depuis la migration 085. Elle empruntait ceux d'Uptime, et un
 * seuil SQL franchi arrivait donc sur le salon désigné pour la
 * disponibilité — la même erreur que Sentinelle avant la 075, corrigée de la
 * même façon, reprise de la ligne existante comprise. Le service notifie par
 * la façade `notify` du SDK, sur la route de chaque base.
 *
 * `items` est ce que le partage et les routes de notification savent des
 * bases sans ouvrir la feature : le domicile d'une base visible d'ici (la
 * sienne, ou l'espace qui la projette), et son nom, déchiffré par le codec
 * ouvert de l'espace appelant. `shareTier: 'open'` l'exige ; le boot refuse
 * un module qui déclare sans l'offrir.
 *
 * Pas de `migrationsDir` : les deux tables du module datent du socle (068,
 * complétée par la 070, jamais déplacées, allowlist dans deveye-feature.json) ;
 * une nouvelle table inaugurera `src/server/migrations/` avec le préfixe
 * `ft_database_`. `project_database_links` (même migration) appartient à
 * Projets.
 */
export const serverEntry: FeatureServer<DatabaseRepo> = {
    createRepo,
    features: databaseHandlers,
    createService(deps) {
        const monitor = new DatabaseMonitor(deps);
        // Projets ne stocke que des identifiants ; avant d'en relier un, il
        // demande si la base existe dans l'espace (le sien : c'est ce que
        // faisait `databases.find` avant le rapatriement), pour qu'un
        // identifiant étranger ne se relie pas et ne trahisse pas son
        // existence. Le domicile seulement, jamais une projection : un projet
        // relie ce que son espace possède.
        const items: DatabaseItemsProvider = {
            exists: async (databaseId, workspaceId) => (await deps.repo.find(databaseId, workspaceId)) !== null
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
        // Le nom est la première clé du blob chiffré à l'étage ouvert ; un blob
        // illisible ou une base disparue vaut `null`, ce que l'écran des canaux
        // montre comme « une cible disparue ».
        labelOf: async (repo, cipher, itemId, workspaceId) => {
            const row = await repo.find(itemId, workspaceId);
            if (!row) return null;
            const stored = await readJson<Partial<StoredDatabase>>(cipher, row.content);
            return typeof stored?.name === 'string' && stored.name.length > 0 ? stored.name : null;
        }
    }
};
