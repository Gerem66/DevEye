import { randomInt } from 'node:crypto';

import type { SdkQueryable } from '@deveye/types/sdk/server';

export interface LinkCode {
    code: string;
    expiresAt: number | null;
    autoApprove: boolean;
}

/**
 * La table `device_link_codes`, côté émission. La consommation d'un code
 * (l'enrôlement, `POST /api/agent/enroll`) reste au socle : route publique,
 * sans session.
 */
export interface LinkCodeRepo {
    create(input: {
        /** Émetteur du code. */
        userId: number;
        /** Espace dans lequel la machine sera rangée à l'enrôlement. */
        workspaceId: number;
        /** `null` mints a code that never expires. */
        ttlSeconds: number;
        autoApprove: boolean;
    }): Promise<LinkCode>;
    /** Les codes encore valables (ni consommés ni expirés) de cet émetteur. */
    listActive(userId: number): Promise<LinkCode[]>;
    /** Toggle auto-approval on one of the caller's still-active codes (else null). */
    setAutoApprove(userId: number, code: string, autoApprove: boolean): Promise<LinkCode | null>;
    /** Delete one of the caller's still-active codes. Returns true if removed. */
    revoke(userId: number, code: string): Promise<boolean>;
}

interface LinkCodeRow {
    code: string;
    expires_at: number | null;
    auto_approve: number;
}

function toLinkCode(row: LinkCodeRow): LinkCode {
    return {
        code: row.code,
        expiresAt: row.expires_at === null ? null : Number(row.expires_at),
        autoApprove: Number(row.auto_approve) === 1
    };
}

function randomCode(): string {
    // Human-typable: 8 unambiguous chars, grouped (XXXX-XXXX). Tiré
    // cryptographiquement : ce code enrôle une machine dans un espace.
    // `randomInt` fait le rejet d'échantillon, l'alphabet de 31 symboles reste
    // uniforme.
    const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    let raw = '';
    for (let i = 0; i < 8; i++) raw += alphabet[randomInt(alphabet.length)];
    return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

export function linkCodeRepo(q: SdkQueryable): LinkCodeRepo {
    return {
        async create({ userId, workspaceId, ttlSeconds, autoApprove }) {
            const now = Math.floor(Date.now() / 1000);
            const expiresAt = now + ttlSeconds;
            const code = randomCode();
            await q.execute(
                'INSERT INTO device_link_codes (code, user_id, workspace_id, expires_at, auto_approve) VALUES (?, ?, ?, ?, ?)',
                [code, userId, workspaceId, expiresAt, autoApprove ? 1 : 0]
            );
            return { code, expiresAt, autoApprove };
        },
        async listActive(userId) {
            const now = Math.floor(Date.now() / 1000);
            const rows = await q.query<LinkCodeRow>(
                `SELECT code, expires_at, auto_approve FROM device_link_codes
                 WHERE user_id = ? AND used_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
                 ORDER BY expires_at IS NULL DESC, expires_at ASC`,
                [userId, now]
            );
            return rows.map(toLinkCode);
        },
        async setAutoApprove(userId, code, autoApprove) {
            const now = Math.floor(Date.now() / 1000);
            const upd = await q.execute(
                `UPDATE device_link_codes SET auto_approve = ?
                 WHERE code = ? AND user_id = ? AND used_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`,
                [autoApprove ? 1 : 0, code, userId, now]
            );
            if (upd.affectedRows === 0) return null;
            const rows = await q.query<LinkCodeRow>(
                'SELECT code, expires_at, auto_approve FROM device_link_codes WHERE code = ?',
                [code]
            );
            return rows[0] ? toLinkCode(rows[0]) : null;
        },
        async revoke(userId, code) {
            const r = await q.execute(
                'DELETE FROM device_link_codes WHERE code = ? AND user_id = ? AND used_at IS NULL',
                [code, userId]
            );
            return r.affectedRows > 0;
        }
    };
}
