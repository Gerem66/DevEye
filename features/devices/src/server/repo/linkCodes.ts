import { randomInt } from 'node:crypto';

import type { SdkQueryable } from '@deveye/types/sdk/server';

export interface LinkCode {
    code: string;
    expiresAt: number;
}

/**
 * La table `device_link_codes`, côté émission. La consommation d'un code
 * (l'enrôlement, `POST /api/agent/enroll`) reste au socle : route publique,
 * sans session. Un code appartient à l'espace qu'il vise : quiconque y tient
 * `devices: write` le relit et le révoque.
 */
export interface LinkCodeRepo {
    create(input: {
        /** Émetteur du code, pour le journal. */
        userId: number;
        /** Espace dans lequel la machine sera rangée à l'enrôlement. */
        workspaceId: number;
        ttlSeconds: number;
    }): Promise<LinkCode>;
    /** Les codes encore valables (ni consommés ni expirés) de cet espace. */
    listActive(workspaceId: number): Promise<LinkCode[]>;
    /** Supprime un code encore valable de cet espace. Vrai s'il a été retiré. */
    revoke(workspaceId: number, code: string): Promise<boolean>;
}

interface LinkCodeRow {
    code: string;
    expires_at: number;
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
        async create({ userId, workspaceId, ttlSeconds }) {
            const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
            const code = randomCode();
            await q.execute(
                'INSERT INTO device_link_codes (code, user_id, workspace_id, expires_at) VALUES (?, ?, ?, ?)',
                [code, userId, workspaceId, expiresAt]
            );
            return { code, expiresAt };
        },
        async listActive(workspaceId) {
            const now = Math.floor(Date.now() / 1000);
            const rows = await q.query<LinkCodeRow>(
                `SELECT code, expires_at FROM device_link_codes
                 WHERE workspace_id = ? AND used_at IS NULL AND expires_at > ?
                 ORDER BY expires_at ASC`,
                [workspaceId, now]
            );
            return rows.map((row) => ({ code: row.code, expiresAt: Number(row.expires_at) }));
        },
        async revoke(workspaceId, code) {
            const r = await q.execute(
                'DELETE FROM device_link_codes WHERE code = ? AND workspace_id = ? AND used_at IS NULL',
                [code, workspaceId]
            );
            return r.affectedRows > 0;
        }
    };
}
