import { DATABASE_BACKUP_PROVIDER, type DatabaseBackupCandidate, type DatabaseBackupProvider } from '@deveye/types/sdk';
import type { DatabaseRow } from '@deveye/types';

import type { Database } from '@/db';
import type { DatabaseMonitor, StoredDatabase } from '@/Services/DatabaseMonitor';
import { openTunnel } from '@/Services/databases/tunnel';
import type Encryption from '@/Services/Encryption';
import { createOpenCipher, type Cipher } from '@/Services/SecureStore';

/**
 * Ce que le module Sauvegardes demande à Bases de données
 * (`DATABASE_BACKUP_PROVIDER`), offert par l'app tant que la feature est
 * native : ses bases nommées (le nom vit chiffré sous le codec de l'espace,
 * que seule cette feature relit), et un ACCÈS ouvert à l'une d'elles, tunnel
 * SSH ou proxy SOCKS compris, exactement le chemin que la supervision emprunte
 * (`DatabaseMonitor.targetOf`, seul endroit qui déchiffre une connexion).
 *
 * Le jour où Bases de données migre en module, son service publie la même
 * clé et ce fichier disparaît : Sauvegardes n'y verra aucune différence.
 */
export { DATABASE_BACKUP_PROVIDER };

interface Deps {
    db: Database;
    crypt: Encryption;
    databases: DatabaseMonitor;
}

export function createDatabaseBackupProvider(deps: Deps): DatabaseBackupProvider {
    // Même mémoïsation par espace que les services de fond : le codec ouvert
    // résout la clé de l'espace une fois, pas à chaque ligne listée.
    const ciphers = new Map<number, Cipher>();
    const cipherFor = (workspaceId: number): Cipher => {
        let cipher = ciphers.get(workspaceId);
        if (!cipher) {
            cipher = createOpenCipher(deps.db, deps.crypt, workspaceId);
            ciphers.set(workspaceId, cipher);
        }
        return cipher;
    };

    const candidateOf = async (row: DatabaseRow, workspaceId: number): Promise<DatabaseBackupCandidate> => {
        let stored: Partial<StoredDatabase> = {};
        try {
            const raw = await cipherFor(workspaceId).tryDecrypt(row.content);
            stored = raw ? (JSON.parse(raw) as Partial<StoredDatabase>) : {};
        } catch {
            // Un blob illisible ne retire pas la base du sélecteur : elle
            // existe, et le run dira ce qui cloche s'il faut la vider.
        }
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
            const rows = await deps.db.databases.list(workspaceId);
            return Promise.all(rows.map((row) => candidateOf(row, workspaceId)));
        },
        async findDatabase(databaseId, workspaceId) {
            const row = await deps.db.databases.find(databaseId, workspaceId);
            return row ? candidateOf(row, workspaceId) : null;
        },
        async openAccess(databaseId, workspaceId) {
            const row = await deps.db.databases.find(databaseId, workspaceId);
            if (!row) return null;
            const target = await deps.databases.targetOf(row, workspaceId);
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
