import type { Queryable } from '../pool';

export interface InstanceSettingRow {
    origin: string;
    value: string;
    updated: number;
    updatedBy: { id: number; username: string } | null;
}

/**
 * Les réglages de l'instance, rangés par origine publique : un serveur de dev
 * et la prod partagent parfois la même base, chacun ne lit que les siens.
 */
export interface InstanceSettingsRepo {
    get(name: string, origin: string): Promise<InstanceSettingRow | null>;
    put(name: string, origin: string, value: string, by: number): Promise<void>;
    remove(name: string, origin: string): Promise<void>;
    /** Toutes les origines, pour montrer les réglages des autres serveurs. */
    listByName(name: string): Promise<InstanceSettingRow[]>;
}

type Raw = { origin: string; value: string; updated: number; updated_by: number | null; username: string | null };

const toRow = (r: Raw): InstanceSettingRow => ({
    origin: r.origin,
    value: r.value,
    updated: Number(r.updated),
    updatedBy: r.updated_by !== null && r.username !== null ? { id: r.updated_by, username: r.username } : null
});

const SELECT = `SELECT s.origin, s.value, s.updated, s.updated_by, u.username
                FROM instance_settings s LEFT JOIN users u ON u.id = s.updated_by`;

export function instanceSettingsRepo(pool: Queryable): InstanceSettingsRepo {
    return {
        async get(name, origin) {
            const r = await pool.query<Raw>(`${SELECT} WHERE s.name = ? AND s.origin = ?`, [name, origin]);
            return r.rows[0] ? toRow(r.rows[0]) : null;
        },
        async put(name, origin, value, by) {
            await pool.query(
                `INSERT INTO instance_settings (name, origin, value, updated, updated_by)
                 VALUES (?, ?, ?, UNIX_TIMESTAMP(), ?)
                 ON DUPLICATE KEY UPDATE value = VALUES(value), updated = VALUES(updated), updated_by = VALUES(updated_by)`,
                [name, origin, value, by]
            );
        },
        async remove(name, origin) {
            await pool.query('DELETE FROM instance_settings WHERE name = ? AND origin = ?', [name, origin]);
        },
        async listByName(name) {
            const r = await pool.query<Raw>(`${SELECT} WHERE s.name = ? ORDER BY s.origin`, [name]);
            return r.rows.map(toRow);
        }
    };
}
