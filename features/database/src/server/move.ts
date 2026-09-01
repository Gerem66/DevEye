import {
    countMovableCells,
    FeatureError,
    resealCells,
    type FeatureItemsMove,
    type MovableCell,
    type SdkQueryable
} from '@deveye/types/sdk/server';

import type { DatabaseRepo } from './repo';

/**
 * Le changement d'espace d'une base : sa fiche, ses secrets et ses alertes.
 * Tout ce dont elle a besoin lui appartient, mot de passe et accès SSH compris,
 * donc rien ne reste derrière.
 *
 * ⚠️ Liste à tenir à jour : toute nouvelle colonne chiffrée suspendue à une base
 * doit y figurer, sinon son contenu reste sous l'ancienne clé et devient
 * illisible. Rien ne peut le détecter, un blob chiffré est indistinguable d'un
 * autre.
 */
const CELLS: readonly MovableCell[] = [
    { table: 'database_connections', idColumn: 'id', ownerColumn: 'id', column: 'content' },
    { table: 'database_connections', idColumn: 'id', ownerColumn: 'id', column: 'secret_enc' },
    { table: 'database_connections', idColumn: 'id', ownerColumn: 'id', column: 'access_content' },
    { table: 'database_connections', idColumn: 'id', ownerColumn: 'id', column: 'access_secret_enc' },
    { table: 'database_connections', idColumn: 'id', ownerColumn: 'id', column: 'last_error' },
    { table: 'database_alerts', idColumn: 'id', ownerColumn: 'database_id', column: 'content' },
    { table: 'database_alerts', idColumn: 'id', ownerColumn: 'database_id', column: 'last_error' }
];

/**
 * Le nom est unique par espace (`uniq_database_name`), et il l'est par un
 * condensé, le chiffrement étant non déterministe : la collision se décide donc
 * sans rien déchiffrer, et avant d'écrire quoi que ce soit.
 */
async function nameTaken(q: SdkQueryable, databaseId: number, toWorkspaceId: number): Promise<boolean> {
    const rows = await q.query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM database_connections
          WHERE workspace_id = ? AND name_ref = (SELECT name_ref FROM database_connections WHERE id = ?)`,
        [toWorkspaceId, databaseId]
    );
    return Number(rows[0]?.n ?? 0) > 0;
}

export const databaseMove: FeatureItemsMove<DatabaseRepo> = {
    async plan({ q, itemId, toWorkspaceId }) {
        const databaseId = Number(itemId);
        const blockers = (await nameTaken(q, databaseId, toWorkspaceId))
            ? ['Une base du même nom existe déjà dans cet espace.']
            : [];
        return { blockers, drops: [], rows: await countMovableCells(q, CELLS, databaseId) };
    },

    async apply({ q, itemId, fromWorkspaceId, toWorkspaceId, ciphers }) {
        const databaseId = Number(itemId);
        await resealCells(q, CELLS, databaseId, ciphers);
        // Les alertes portent leur propre `workspace_id` : sans cette ligne
        // elles resteraient dans l'espace quitté, invisibles et actives.
        await q.execute('UPDATE database_alerts SET workspace_id = ? WHERE database_id = ? AND workspace_id = ?', [
            toWorkspaceId,
            databaseId,
            fromWorkspaceId
        ]);
        const next = await q.query<{ next: number }>(
            'SELECT COALESCE(MAX(sort_order) + 1, 0) AS next FROM database_connections WHERE workspace_id = ?',
            [toWorkspaceId]
        );
        const res = await q.execute(
            'UPDATE database_connections SET workspace_id = ?, sort_order = ? WHERE id = ? AND workspace_id = ?',
            [toWorkspaceId, Number(next[0]?.next ?? 0), databaseId, fromWorkspaceId]
        );
        if (res.affectedRows !== 1) {
            throw new FeatureError('not_found', 'Cette base n’est plus dans cet espace : déplacement annulé.');
        }
    }
};
