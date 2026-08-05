import { randomBytes } from 'crypto';
import type { WorkspaceInviteRow } from 'deveye-types';
import type { Queryable } from '../pool';

type Q = Queryable;

export interface CreateInviteInput {
    workspaceId: number;
    createdBy: number;
    /** `null` → n'expire jamais. */
    ttlSeconds: number | null;
    /** `null` → usages illimités. */
    maxUses: number | null;
}

/** Ce qu'une acceptation réussie révèle du jeton consommé. */
export interface ConsumedInvite {
    workspaceId: number;
}

export interface WorkspaceInvitesRepo {
    create(input: CreateInviteInput): Promise<WorkspaceInviteRow>;
    /** Invitations encore utilisables d'un espace, la plus récente d'abord. */
    listActive(workspaceId: number): Promise<WorkspaceInviteRow[]>;
    /** Lecture sans consommation, pour afficher l'espace avant d'accepter. */
    peek(token: string): Promise<WorkspaceInviteRow | null>;
    /**
     * Consomme un usage. Renvoie `null` si le jeton est inconnu, révoqué, expiré
     * ou épuisé.
     */
    consume(token: string): Promise<ConsumedInvite | null>;
    revoke(workspaceId: number, token: string): Promise<boolean>;
}

/**
 * Prédicat « ce jeton est encore utilisable ».
 *
 * Écrit une seule fois : validation, listage et consommation doivent partager
 * exactement la même définition, faute de quoi un lien pourrait s'afficher comme
 * actif tout en étant refusé (ou l'inverse). Le paramètre est l'instant courant.
 */
const LIVE = 'revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?) AND (max_uses IS NULL OR uses < max_uses)';

/**
 * 32 octets en base64url — un lien se copie-colle, il n'a pas à être tapé, donc
 * rien ne justifie de rogner sur l'entropie. À comparer aux codes de liaison
 * d'appareil, volontairement courts et lisibles parce qu'ils se saisissent à la
 * main sur une machine, et qui n'ouvrent qu'un enrôlement en attente
 * d'approbation — pas un accès à des données.
 */
function randomToken(): string {
    return randomBytes(32).toString('base64url');
}

export function workspaceInvitesRepo(pool: Q): WorkspaceInvitesRepo {
    const now = (): number => Math.floor(Date.now() / 1000);

    return {
        async create({ workspaceId, createdBy, ttlSeconds, maxUses }) {
            const token = randomToken();
            await pool.query(
                'INSERT INTO workspace_invites (token, workspace_id, created_by, expires_at, max_uses) VALUES (?, ?, ?, ?, ?)',
                [token, workspaceId, createdBy, ttlSeconds === null ? null : now() + ttlSeconds, maxUses]
            );
            const r = await pool.query<WorkspaceInviteRow>('SELECT * FROM workspace_invites WHERE token = ?', [token]);
            return r.rows[0];
        },
        async listActive(workspaceId) {
            const r = await pool.query<WorkspaceInviteRow>(
                `SELECT * FROM workspace_invites WHERE workspace_id = ? AND ${LIVE} ORDER BY created DESC`,
                [workspaceId, now()]
            );
            return r.rows;
        },
        async peek(token) {
            const r = await pool.query<WorkspaceInviteRow>(
                `SELECT * FROM workspace_invites WHERE token = ? AND ${LIVE}`,
                [token, now()]
            );
            return r.rows[0] ?? null;
        },
        async consume(token) {
            // Incrémenter ET valider dans la même instruction : deux acceptations
            // simultanées du dernier usage disponible ne peuvent pas passer toutes
            // les deux, puisque la seconde ne verra plus `uses < max_uses`.
            const res = await pool.query(`UPDATE workspace_invites SET uses = uses + 1 WHERE token = ? AND ${LIVE}`, [
                token,
                now()
            ]);
            if (res.rowCount !== 1) return null;
            const r = await pool.query<{ workspace_id: number }>(
                'SELECT workspace_id FROM workspace_invites WHERE token = ?',
                [token]
            );
            const row = r.rows[0];
            return row ? { workspaceId: row.workspace_id } : null;
        },
        async revoke(workspaceId, token) {
            const res = await pool.query(
                'UPDATE workspace_invites SET revoked_at = ? WHERE token = ? AND workspace_id = ? AND revoked_at IS NULL',
                [now(), token, workspaceId]
            );
            return res.rowCount > 0;
        }
    };
}
