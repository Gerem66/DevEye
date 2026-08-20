import type { ItemAccess, ItemRoleGrantRow, ItemShareRow } from 'deveye-types';

import type { Queryable } from '../pool';

type Q = Queryable;

/**
 * Les projections d'éléments entre espaces, et les restrictions par rôle.
 *
 * Deux tables, une seule raison d'être : rendre un élément **visible** ailleurs
 * sans le déplacer. Il garde un domicile — `home_workspace_id` — dont la clé
 * seule le déchiffre.
 */
export interface ItemSharingRepo {
    /** Les espaces où cet élément est projeté, l'origine exclue. */
    sharesOf(feature: string, itemId: number, homeWorkspaceId: number): Promise<ItemShareRow[]>;
    /**
     * Les éléments d'une feature projetés **vers** cet espace.
     *
     * Lu une fois par listage : la question « d'où vient cette ligne ? » se pose
     * pour chacune, et une requête par ligne mettrait un aller-retour devant
     * chaque affichage.
     */
    sharedInto(workspaceId: number, feature: string): Promise<ItemShareRow[]>;
    /** Cet élément précis est-il projeté vers cet espace ? */
    findShare(workspaceId: number, feature: string, itemId: number): Promise<ItemShareRow | null>;
    share(row: Omit<ItemShareRow, 'created'>): Promise<void>;
    unshare(workspaceId: number, feature: string, itemId: number): Promise<void>;
    /** Retire toutes les projections d'un élément — à sa suppression. */
    forgetItem(feature: string, itemId: number, homeWorkspaceId: number): Promise<void>;
    /**
     * Les espaces reliés à celui-ci par au moins une projection de cette
     * feature, dans les deux sens : ceux qui regardent ses éléments, et ceux
     * dont il regarde les éléments.
     *
     * C'est l'éventail de la diffusion live : une écriture ici doit rafraîchir
     * les fenêtres, et une écriture faite depuis une fenêtre doit rafraîchir le
     * domicile et les autres fenêtres.
     */
    linkedWorkspaces(workspaceId: number, feature: string): Promise<number[]>;

    /** Les restrictions posées depuis cet espace sur cet élément. */
    grantsOf(workspaceId: number, feature: string, itemId: number): Promise<ItemRoleGrantRow[]>;
    /**
     * Les restrictions qui touchent **un rôle**, pour toute une feature.
     *
     * C'est la forme dont la résolution d'accès a besoin : elle veut savoir, en
     * une requête, quels éléments sont abaissés pour l'appelant.
     */
    grantsForRole(workspaceId: number, feature: string, roleId: number): Promise<ItemRoleGrantRow[]>;
    setGrant(
        workspaceId: number,
        feature: string,
        itemId: number,
        roleId: number,
        access: ItemAccess | null
    ): Promise<void>;
}

export function itemSharingRepo(pool: Q): ItemSharingRepo {
    return {
        async sharesOf(feature, itemId, homeWorkspaceId) {
            const r = await pool.query<ItemShareRow>(
                `SELECT * FROM item_shares
                  WHERE feature = ? AND item_id = ? AND home_workspace_id = ?`,
                [feature, itemId, homeWorkspaceId]
            );
            return r.rows;
        },

        async sharedInto(workspaceId, feature) {
            const r = await pool.query<ItemShareRow>(
                'SELECT * FROM item_shares WHERE workspace_id = ? AND feature = ?',
                [workspaceId, feature]
            );
            return r.rows;
        },

        async findShare(workspaceId, feature, itemId) {
            const r = await pool.query<ItemShareRow>(
                'SELECT * FROM item_shares WHERE workspace_id = ? AND feature = ? AND item_id = ?',
                [workspaceId, feature, itemId]
            );
            return r.rows[0] ?? null;
        },

        async share({ workspace_id, feature, item_id, home_workspace_id, shared_by_user_id }) {
            await pool.query(
                `INSERT INTO item_shares (workspace_id, feature, item_id, home_workspace_id, shared_by_user_id)
                 VALUES (?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE home_workspace_id = VALUES(home_workspace_id)`,
                [workspace_id, feature, item_id, home_workspace_id, shared_by_user_id]
            );
        },

        async unshare(workspaceId, feature, itemId) {
            await pool.query('DELETE FROM item_shares WHERE workspace_id = ? AND feature = ? AND item_id = ?', [
                workspaceId,
                feature,
                itemId
            ]);
        },

        async linkedWorkspaces(workspaceId, feature) {
            const r = await pool.query<{ id: number }>(
                `SELECT DISTINCT workspace_id AS id FROM item_shares
                  WHERE home_workspace_id = ? AND feature = ?
                 UNION
                 SELECT DISTINCT home_workspace_id AS id FROM item_shares
                  WHERE workspace_id = ? AND feature = ?`,
                [workspaceId, feature, workspaceId, feature]
            );
            return r.rows.map((row) => row.id);
        },

        async forgetItem(feature, itemId, homeWorkspaceId) {
            await pool.query('DELETE FROM item_shares WHERE feature = ? AND item_id = ? AND home_workspace_id = ?', [
                feature,
                itemId,
                homeWorkspaceId
            ]);
            // Les restrictions aussi : elles désignent un élément qui n'existe
            // plus, et s'appliqueraient au prochain à hériter de l'identifiant.
            await pool.query('DELETE FROM item_role_grants WHERE feature = ? AND item_id = ?', [feature, itemId]);
        },

        async grantsOf(workspaceId, feature, itemId) {
            const r = await pool.query<ItemRoleGrantRow>(
                'SELECT * FROM item_role_grants WHERE workspace_id = ? AND feature = ? AND item_id = ?',
                [workspaceId, feature, itemId]
            );
            return r.rows;
        },

        async grantsForRole(workspaceId, feature, roleId) {
            const r = await pool.query<ItemRoleGrantRow>(
                'SELECT * FROM item_role_grants WHERE workspace_id = ? AND feature = ? AND role_id = ?',
                [workspaceId, feature, roleId]
            );
            return r.rows;
        },

        async setGrant(workspaceId, feature, itemId, roleId, access) {
            if (access === null) {
                // L'absence de ligne **est** « rien de particulier ». Écrire une
                // valeur neutre ferait grossir la table d'exceptions qui n'en
                // sont pas, et brouillerait la lecture de l'écran.
                await pool.query(
                    `DELETE FROM item_role_grants
                      WHERE workspace_id = ? AND feature = ? AND item_id = ? AND role_id = ?`,
                    [workspaceId, feature, itemId, roleId]
                );
                return;
            }
            await pool.query(
                `INSERT INTO item_role_grants (workspace_id, feature, item_id, role_id, access)
                 VALUES (?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE access = VALUES(access)`,
                [workspaceId, feature, itemId, roleId, access]
            );
        }
    };
}
