import { randomBytes } from 'crypto';
import type { Queryable } from '../pool';

type Q = Queryable;

export interface UserInviteRow {
    token: string;
    created_by: number;
    email: string | null;
    workspace_id: number | null;
    expires_at: number | null;
    max_uses: number | null;
    uses: number;
    revoked_at: number | null;
    created: number;
}

export interface CreateUserInviteInput {
    createdBy: number;
    /** Verrouille l'invitation sur une adresse, ou `null` pour l'ouvrir. */
    email: string | null;
    /** Espace rejoint dès la création du compte, ou `null`. */
    workspaceId: number | null;
    ttlSeconds: number | null;
    maxUses: number | null;
}

export interface UserInvitesRepo {
    create(input: CreateUserInviteInput): Promise<UserInviteRow>;
    listActive(): Promise<UserInviteRow[]>;
    consume(token: string, email: string): Promise<UserInviteRow | null>;
    revoke(token: string): Promise<boolean>;
}

/** Même prédicat partagé que les invitations d'espace : une seule définition. */
const LIVE = 'revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?) AND (max_uses IS NULL OR uses < max_uses)';

export function userInvitesRepo(pool: Q): UserInvitesRepo {
    const now = (): number => Math.floor(Date.now() / 1000);

    return {
        async create({ createdBy, email, workspaceId, ttlSeconds, maxUses }) {
            const token = randomBytes(32).toString('base64url');
            await pool.query(
                `INSERT INTO user_invites (token, created_by, email, workspace_id, expires_at, max_uses)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [token, createdBy, email, workspaceId, ttlSeconds === null ? null : now() + ttlSeconds, maxUses]
            );
            const r = await pool.query<UserInviteRow>('SELECT * FROM user_invites WHERE token = ?', [token]);
            return r.rows[0];
        },
        async listActive() {
            const r = await pool.query<UserInviteRow>(
                `SELECT * FROM user_invites WHERE ${LIVE} ORDER BY created DESC`,
                [now()]
            );
            return r.rows;
        },
        async consume(token, email) {
            // Incrémenter et valider d'un seul coup : deux inscriptions simultanées
            // sur le dernier usage ne passent pas toutes les deux. Le verrou
            // d'adresse fait partie de la condition.
            const res = await pool.query(
                `UPDATE user_invites SET uses = uses + 1
                 WHERE token = ? AND ${LIVE} AND (email IS NULL OR email = ?)`,
                [token, now(), email]
            );
            if (res.rowCount !== 1) return null;
            const r = await pool.query<UserInviteRow>('SELECT * FROM user_invites WHERE token = ?', [token]);
            return r.rows[0] ?? null;
        },
        async revoke(token) {
            const res = await pool.query(
                'UPDATE user_invites SET revoked_at = ? WHERE token = ? AND revoked_at IS NULL',
                [now(), token]
            );
            return res.rowCount > 0;
        }
    };
}
