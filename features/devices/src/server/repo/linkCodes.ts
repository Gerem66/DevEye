import { randomInt } from 'node:crypto';

import type { SdkQueryable } from '@deveye/types/sdk/server';

export interface LinkCode {
    code: string;
    expiresAt: number;
    maxUses: number;
    uses: number;
}

/**
 * La table `device_link_codes`, côté émission. La consommation d'un code
 * (l'enrôlement, `POST /api/agent/enroll`) reste au socle : route publique,
 * sans session. Un code appartient à l'espace qu'il vise : quiconque y tient
 * `devices: write` le relit et le révoque. Il vaut `max_uses` enrôlements
 * avant son échéance.
 */
export interface LinkCodeRepo {
    create(input: {
        /** Émetteur du code, pour le journal. */
        userId: number;
        /** Espace dans lequel la machine sera rangée à l'enrôlement. */
        workspaceId: number;
        ttlSeconds: number;
        maxUses: number;
    }): Promise<LinkCode>;
    /** Les codes encore valables (des usages restants, pas d'échéance passée) de cet espace. */
    listActive(workspaceId: number): Promise<LinkCode[]>;
    /** Supprime un code encore valable de cet espace, entamé ou non. Vrai s'il a été retiré. */
    revoke(workspaceId: number, code: string): Promise<boolean>;
}

interface LinkCodeRow {
    code: string;
    expires_at: number;
    max_uses: number;
    uses: number;
}

/** Au-delà, un code est une clé durable ou partagée : il s'allonge. */
const SHORT_CODE_TTL_SECONDS = 60 * 60;

function randomCode(groups: number): string {
    // Human-typable: unambiguous chars in groups of four (XXXX-XXXX). Tiré
    // cryptographiquement : ce code enrôle une machine dans un espace.
    // `randomInt` fait le rejet d'échantillon, l'alphabet de 31 symboles reste
    // uniforme.
    const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    const parts: string[] = [];
    for (let g = 0; g < groups; g++) {
        let part = '';
        for (let i = 0; i < 4; i++) part += alphabet[randomInt(alphabet.length)];
        parts.push(part);
    }
    return parts.join('-');
}

export function linkCodeRepo(q: SdkQueryable): LinkCodeRepo {
    return {
        async create({ userId, workspaceId, ttlSeconds, maxUses }) {
            const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
            // Un code court se tape à la main ; qui sert plusieurs fois ou longtemps
            // vaut la peine d'être plus dur à deviner.
            const code = randomCode(maxUses > 1 || ttlSeconds > SHORT_CODE_TTL_SECONDS ? 3 : 2);
            await q.execute(
                'INSERT INTO device_link_codes (code, user_id, workspace_id, expires_at, max_uses) VALUES (?, ?, ?, ?, ?)',
                [code, userId, workspaceId, expiresAt, maxUses]
            );
            return { code, expiresAt, maxUses, uses: 0 };
        },
        async listActive(workspaceId) {
            const now = Math.floor(Date.now() / 1000);
            const rows = await q.query<LinkCodeRow>(
                `SELECT code, expires_at, max_uses, uses FROM device_link_codes
                 WHERE workspace_id = ? AND uses < max_uses AND expires_at > ?
                 ORDER BY expires_at ASC`,
                [workspaceId, now]
            );
            return rows.map((row) => ({
                code: row.code,
                expiresAt: Number(row.expires_at),
                maxUses: Number(row.max_uses),
                uses: Number(row.uses)
            }));
        },
        async revoke(workspaceId, code) {
            const r = await q.execute(
                'DELETE FROM device_link_codes WHERE code = ? AND workspace_id = ? AND uses < max_uses',
                [code, workspaceId]
            );
            return r.affectedRows > 0;
        }
    };
}
