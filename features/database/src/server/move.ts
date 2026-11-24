import {
    countMovableCells,
    FeatureError,
    itemDigestTaken,
    movableCellsOf,
    rekeyItemDigests,
    resealCells,
    type FeatureItemsMove
} from '@deveye/types/sdk/server';

import type { DatabaseRepo } from './repo';
import { databaseTree } from './copy';

/**
 * Le changement d'espace d'une base : sa fiche, ses secrets et ses alertes.
 * Tout ce dont elle a besoin lui appartient, mot de passe et accès SSH compris,
 * donc rien ne reste derrière.
 *
 * Les cellules à resceller viennent de l'arbre de `copy.ts`, la seule liste à tenir.
 */
const CELLS = movableCellsOf(databaseTree);

export const databaseMove: FeatureItemsMove<DatabaseRepo> = {
    async plan({ q, itemId, toWorkspaceId, cipher, keys }) {
        const databaseId = Number(itemId);
        // Le nom est unique par espace (`uniq_database_name`), par un condensé lié
        // à l'espace : celui de l'arrivée se calcule depuis le nom, avant d'écrire
        // quoi que ce soit.
        const taken = await itemDigestTaken(q, databaseTree, databaseId, { cipher, keys, workspaceId: toWorkspaceId });
        const blockers = taken ? ['Une base du même nom existe déjà dans cet espace.'] : [];
        return { blockers, drops: [], rows: await countMovableCells(q, CELLS, databaseId) };
    },

    async apply({ q, itemId, fromWorkspaceId, toWorkspaceId, ciphers, keys }) {
        const databaseId = Number(itemId);
        await resealCells(q, CELLS, databaseId, ciphers);
        await rekeyItemDigests(q, databaseTree, databaseId, { cipher: ciphers.to, keys, workspaceId: toWorkspaceId });
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
