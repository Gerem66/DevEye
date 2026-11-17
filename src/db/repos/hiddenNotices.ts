import type { Queryable } from '../pool';

/**
 * Les pages où un compte a fermé le bandeau « Aucune notification
 * configurée ». `itemId` vaut 0 pour la liste de la fonctionnalité, comme les
 * routes de notification.
 */
export interface HiddenNoticesRepo {
    isHidden(userId: number, workspaceId: number, feature: string, itemId: number): Promise<boolean>;
    hide(userId: number, workspaceId: number, feature: string, itemId: number): Promise<void>;
    countFor(userId: number): Promise<number>;
    clearFor(userId: number): Promise<void>;
    /** L'élément supprimé ou parti dans un autre espace : pour tous les comptes. */
    forgetItem(workspaceId: number, feature: string, itemId: number): Promise<void>;
    /** Le compte a quitté l'espace : ses pages lui sont devenues invisibles. */
    forgetMember(userId: number, workspaceId: number): Promise<void>;
}

export function hiddenNoticesRepo(pool: Queryable): HiddenNoticesRepo {
    return {
        async isHidden(userId, workspaceId, feature, itemId) {
            const r = await pool.query<{ one: number }>(
                `SELECT 1 AS one FROM user_hidden_notices
                 WHERE user_id = ? AND workspace_id = ? AND feature = ? AND item_id = ?`,
                [userId, workspaceId, feature, itemId]
            );
            return r.rows.length > 0;
        },
        async hide(userId, workspaceId, feature, itemId) {
            await pool.query(
                'INSERT IGNORE INTO user_hidden_notices (user_id, workspace_id, feature, item_id) VALUES (?, ?, ?, ?)',
                [userId, workspaceId, feature, itemId]
            );
        },
        async countFor(userId) {
            const r = await pool.query<{ n: number }>(
                'SELECT COUNT(*) AS n FROM user_hidden_notices WHERE user_id = ?',
                [userId]
            );
            return Number(r.rows[0]?.n ?? 0);
        },
        async clearFor(userId) {
            await pool.query('DELETE FROM user_hidden_notices WHERE user_id = ?', [userId]);
        },
        async forgetItem(workspaceId, feature, itemId) {
            await pool.query('DELETE FROM user_hidden_notices WHERE workspace_id = ? AND feature = ? AND item_id = ?', [
                workspaceId,
                feature,
                itemId
            ]);
        },
        async forgetMember(userId, workspaceId) {
            await pool.query('DELETE FROM user_hidden_notices WHERE user_id = ? AND workspace_id = ?', [
                userId,
                workspaceId
            ]);
        }
    };
}
