import type { WeatherFormat, WeatherLocationRow, WeatherProvider, WeatherProviderKeyRow } from 'deveye-types';
import { randomUUID } from 'crypto';
import type { Queryable } from '../pool';

type Q = Queryable;

export interface CreateWeatherLocationInput {
    userId: number;
    workspaceId: number;
    label: string;
    latitude: number;
    longitude: number;
    format: WeatherFormat;
    days: number;
    provider: WeatherProvider;
    /** Encrypted per-city API key, or null. */
    apiKeyEnc?: string | null;
}

export interface WeatherRepo {
    listLocations(workspaceId: number): Promise<WeatherLocationRow[]>;
    findLocation(id: string, workspaceId: number): Promise<WeatherLocationRow | null>;
    createLocation(input: CreateWeatherLocationInput): Promise<WeatherLocationRow>;
    updateLocation(
        id: string,
        workspaceId: number,
        patch: {
            format?: WeatherFormat;
            days?: number;
            position?: number;
            provider?: WeatherProvider;
            /** Encrypted key to store, or null to clear. Omit to leave unchanged. */
            apiKeyEnc?: string | null;
        }
    ): Promise<WeatherLocationRow | null>;
    deleteLocation(id: string, workspaceId: number): Promise<boolean>;
    /** Reorder by assigning `position` to each id by its index in `ids`. */
    reorderLocations(workspaceId: number, ids: string[]): Promise<WeatherLocationRow[]>;
    /** Mark `id` as the user's primary location and clear it on the others. */
    setPrimaryLocation(workspaceId: number, id: string): Promise<WeatherLocationRow[]>;
    getKey(workspaceId: number, provider: WeatherProvider): Promise<WeatherProviderKeyRow | null>;
    setKey(workspaceId: number, provider: WeatherProvider, keyEnc: string): Promise<void>;
    deleteKey(workspaceId: number, provider: WeatherProvider): Promise<void>;
}

export function weatherRepo(pool: Q): WeatherRepo {
    return {
        async listLocations(workspaceId) {
            const r = await pool.query<WeatherLocationRow>(
                'SELECT * FROM weather_locations WHERE workspace_id = ? ORDER BY position ASC, created ASC',
                [workspaceId]
            );
            return r.rows;
        },
        async findLocation(id, workspaceId) {
            const r = await pool.query<WeatherLocationRow>(
                'SELECT * FROM weather_locations WHERE id = ? AND workspace_id = ?',
                [id, workspaceId]
            );
            return r.rows[0] ?? null;
        },
        async createLocation({ userId, workspaceId, label, latitude, longitude, format, days, provider, apiKeyEnc }) {
            const id = randomUUID();
            const posRow = await pool.query<{ next: number }>(
                'SELECT COALESCE(MAX(position) + 1, 0) AS next FROM weather_locations WHERE workspace_id = ?',
                [workspaceId]
            );
            const position = Number(posRow.rows[0]?.next ?? 0);
            // The first city a user adds is automatically their primary one.
            const isPrimary = position === 0 ? 1 : 0;
            await pool.query(
                `INSERT INTO weather_locations (id, user_id, workspace_id, label, latitude, longitude, format, days, provider, position, is_primary, api_key_enc)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    id,
                    userId,
                    workspaceId,
                    label,
                    latitude,
                    longitude,
                    format,
                    days,
                    provider,
                    position,
                    isPrimary,
                    apiKeyEnc ?? null
                ]
            );
            const r = await pool.query<WeatherLocationRow>('SELECT * FROM weather_locations WHERE id = ?', [id]);
            return r.rows[0];
        },
        async updateLocation(id, workspaceId, patch) {
            const sets: string[] = [];
            const params: unknown[] = [];
            if (patch.format !== undefined) {
                sets.push('format = ?');
                params.push(patch.format);
            }
            if (patch.days !== undefined) {
                sets.push('days = ?');
                params.push(patch.days);
            }
            if (patch.position !== undefined) {
                sets.push('position = ?');
                params.push(patch.position);
            }
            if (patch.provider !== undefined) {
                sets.push('provider = ?');
                params.push(patch.provider);
            }
            if (patch.apiKeyEnc !== undefined) {
                sets.push('api_key_enc = ?');
                params.push(patch.apiKeyEnc);
            }
            if (sets.length === 0) return this.findLocation(id, workspaceId);
            params.push(id, workspaceId);
            const res = await pool.query(
                `UPDATE weather_locations SET ${sets.join(', ')} WHERE id = ? AND workspace_id = ?`,
                params
            );
            if (res.rowCount === 0) return null;
            return this.findLocation(id, workspaceId);
        },
        async deleteLocation(id, workspaceId) {
            const target = await this.findLocation(id, workspaceId);
            const r = await pool.query('DELETE FROM weather_locations WHERE id = ? AND workspace_id = ?', [
                id,
                workspaceId
            ]);
            if (r.rowCount === 0) return false;
            // If the primary city was removed, promote the first remaining one.
            if (target?.is_primary === 1) {
                const next = await this.listLocations(workspaceId);
                if (next[0]) {
                    await pool.query('UPDATE weather_locations SET is_primary = 1 WHERE id = ? AND workspace_id = ?', [
                        next[0].id,
                        workspaceId
                    ]);
                }
            }
            return true;
        },
        async reorderLocations(workspaceId, ids) {
            // Assign each id its position by index; only rows owned by the user
            // are touched, so stray ids are silently ignored.
            for (let i = 0; i < ids.length; i++) {
                await pool.query('UPDATE weather_locations SET position = ? WHERE id = ? AND workspace_id = ?', [
                    i,
                    ids[i],
                    workspaceId
                ]);
            }
            return this.listLocations(workspaceId);
        },
        async setPrimaryLocation(workspaceId, id) {
            await pool.query('UPDATE weather_locations SET is_primary = (id = ?) WHERE workspace_id = ?', [
                id,
                workspaceId
            ]);
            return this.listLocations(workspaceId);
        },
        async getKey(workspaceId, provider) {
            const r = await pool.query<WeatherProviderKeyRow>(
                'SELECT * FROM weather_provider_keys WHERE workspace_id = ? AND provider = ?',
                [workspaceId, provider]
            );
            return r.rows[0] ?? null;
        },
        async setKey(workspaceId, provider, keyEnc) {
            await pool.query(
                `INSERT INTO weather_provider_keys (workspace_id, provider, key_enc)
                 VALUES (?, ?, ?)
                 ON DUPLICATE KEY UPDATE key_enc = VALUES(key_enc)`,
                [workspaceId, provider, keyEnc]
            );
        },
        async deleteKey(workspaceId, provider) {
            await pool.query('DELETE FROM weather_provider_keys WHERE workspace_id = ? AND provider = ?', [
                workspaceId,
                provider
            ]);
        }
    };
}
