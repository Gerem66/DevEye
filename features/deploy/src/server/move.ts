import {
    countMovableCells,
    FeatureError,
    resealCells,
    type FeatureItemsMove,
    type MovableCell
} from '@deveye/types/sdk/server';

import type { DeployRepo } from './repo';

/**
 * Le changement d'espace d'une cible : sa fiche et son historique de
 * déploiements. Le jeton, lui, appartient à l'espace quitté et ne suit pas : la
 * cible arrive sans lui, donc indéployable, état que la feature sait déjà dire
 * (`credential_id NULL`). En rattacher un de l'arrivée est un geste de son
 * propriétaire, pas un effet de bord d'un déplacement.
 *
 * ⚠️ Liste à tenir à jour : toute nouvelle colonne chiffrée suspendue à une
 * cible doit y figurer, sinon son contenu reste sous l'ancienne clé et devient
 * illisible. Rien ne peut le détecter, un blob chiffré est indistinguable d'un
 * autre.
 */
const CELLS: readonly MovableCell[] = [
    { table: 'deploy_targets', idColumn: 'id', ownerColumn: 'id', column: 'content' },
    { table: 'deployments', idColumn: 'id', ownerColumn: 'target_id', column: 'content' }
];

export const deployMove: FeatureItemsMove<DeployRepo> = {
    async plan({ q, itemId }) {
        const targetId = Number(itemId);
        const rows = await q.query<{ credential_id: number | null }>(
            'SELECT credential_id FROM deploy_targets WHERE id = ?',
            [targetId]
        );
        return {
            blockers: [],
            drops:
                rows[0]?.credential_id != null
                    ? ['Son jeton de déploiement, qui appartient à cet espace : la cible arrivera indéployable']
                    : [],
            rows: await countMovableCells(q, CELLS, targetId)
        };
    },

    async apply({ q, itemId, fromWorkspaceId, toWorkspaceId, ciphers }) {
        const targetId = Number(itemId);
        await resealCells(q, CELLS, targetId, ciphers);
        // L'historique porte son propre `workspace_id` : sans cette ligne il
        // resterait dans l'espace quitté, orphelin de sa cible.
        await q.execute('UPDATE deployments SET workspace_id = ? WHERE target_id = ? AND workspace_id = ?', [
            toWorkspaceId,
            targetId,
            fromWorkspaceId
        ]);
        const next = await q.query<{ next: number }>(
            'SELECT COALESCE(MAX(sort_order) + 1, 0) AS next FROM deploy_targets WHERE workspace_id = ?',
            [toWorkspaceId]
        );
        const res = await q.execute(
            `UPDATE deploy_targets SET workspace_id = ?, credential_id = NULL, sort_order = ?
              WHERE id = ? AND workspace_id = ?`,
            [toWorkspaceId, Number(next[0]?.next ?? 0), targetId, fromWorkspaceId]
        );
        if (res.affectedRows !== 1) {
            throw new FeatureError('not_found', 'Cette cible n’est plus dans cet espace : déplacement annulé.');
        }
    }
};
