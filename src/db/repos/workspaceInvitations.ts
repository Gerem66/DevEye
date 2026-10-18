import type { WorkspaceInvitationRow } from '@deveye/types';
import type { Queryable } from '../pool';

/** Une invitation reçue, avec de quoi la présenter à l'invité. */
export type ReceivedInvitationRow = WorkspaceInvitationRow & {
    workspace_name: string;
    inviter_username: string;
};

/**
 * Les invitations ouvertes. Une invitation expirée n'est plus lue nulle part :
 * elle part avec son espace, quand l'adresse est réinvitée, ou à la purge.
 */
export interface WorkspaceInvitationsRepo {
    listByWorkspace(workspaceId: number, now: number): Promise<WorkspaceInvitationRow[]>;
    /** Celles adressées à cette adresse, l'espace et l'invitant résolus. */
    listByEmail(email: string, now: number): Promise<ReceivedInvitationRow[]>;
    find(id: number, workspaceId: number): Promise<WorkspaceInvitationRow | null>;
    /** Pose l'invitation, ou renouvelle celle que l'adresse a déjà dans cet espace. */
    upsert(input: {
        workspaceId: number;
        email: string;
        roleId: number | null;
        invitedBy: number;
        now: number;
        expiresAt: number;
    }): Promise<void>;
    remove(id: number, workspaceId: number): Promise<void>;
    /** Celles expirées avant `cutoff`. */
    purgeBefore(cutoff: number, batch: number): Promise<number>;
}

export function workspaceInvitationsRepo(pool: Queryable): WorkspaceInvitationsRepo {
    return {
        async listByWorkspace(workspaceId, now) {
            const r = await pool.query<WorkspaceInvitationRow>(
                'SELECT * FROM workspace_invitations WHERE workspace_id = ? AND expires_at > ? ORDER BY created_at ASC',
                [workspaceId, now]
            );
            return r.rows;
        },
        async listByEmail(email, now) {
            const r = await pool.query<ReceivedInvitationRow>(
                `SELECT i.*, w.name AS workspace_name, u.username AS inviter_username
                 FROM workspace_invitations i
                 JOIN workspaces w ON w.id = i.workspace_id
                 JOIN users u ON u.id = i.invited_by
                 WHERE i.email = ? AND i.expires_at > ?
                 ORDER BY i.created_at ASC`,
                [email, now]
            );
            return r.rows;
        },
        async find(id, workspaceId) {
            const r = await pool.query<WorkspaceInvitationRow>(
                'SELECT * FROM workspace_invitations WHERE id = ? AND workspace_id = ?',
                [id, workspaceId]
            );
            return r.rows[0] ?? null;
        },
        async upsert({ workspaceId, email, roleId, invitedBy, now, expiresAt }) {
            await pool.query(
                `INSERT INTO workspace_invitations (workspace_id, email, role_id, invited_by, created_at, expires_at)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE role_id = VALUES(role_id), invited_by = VALUES(invited_by),
                     created_at = VALUES(created_at), expires_at = VALUES(expires_at)`,
                [workspaceId, email, roleId, invitedBy, now, expiresAt]
            );
        },
        async remove(id, workspaceId) {
            await pool.query('DELETE FROM workspace_invitations WHERE id = ? AND workspace_id = ?', [id, workspaceId]);
        },
        async purgeBefore(cutoff, batch) {
            const r = await pool.query('DELETE FROM workspace_invitations WHERE expires_at < ? LIMIT ?', [
                cutoff,
                batch
            ]);
            return r.rowCount;
        }
    };
}
