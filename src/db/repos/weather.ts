import type { WeatherFormat, WeatherLocationRow, WeatherProvider, WeatherProviderKeyRow } from 'deveye-types';
import { randomUUID } from 'crypto';
import type { Queryable } from '../pool';

type Q = Queryable;

export interface CreateWeatherLocationInput {
    userId: number;
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
    listLocations(userId: number): Promise<WeatherLocationRow[]>;
    findLocation(id: string, userId: number): Promise<WeatherLocationRow | null>;
    createLocation(input: CreateWeatherLocationInput): Promise<WeatherLocationRow>;
    updateLocation(
        id: string,
        userId: number,
        patch: {
            format?: WeatherFormat;
            days?: number;
            position?: number;
            provider?: WeatherProvider;
            /** Encrypted key to store, or null to clear. Omit to leave unchanged. */
            apiKeyEnc?: string | null;
        }
    ): Promise<WeatherLocationRow | null>;
    deleteLocation(id: string, userId: number): Promise<boolean>;
    /** Reorder by assigning `position` to each id by its index in `ids`. */
    reorderLocations(userId: number, ids: string[]): Promise<WeatherLocationRow[]>;
    /** Mark `id` as the user's primary location and clear it on the others. */
    setPrimaryLocation(userId: number, id: string): Promise<WeatherLocationRow[]>;
    getKey(userId: number, provider: WeatherProvider): Promise<WeatherProviderKeyRow | null>;
    setKey(userId: number, provider: WeatherProvider, keyEnc: string): Promise<void>;
    deleteKey(userId: number, provider: WeatherProvider): Promise<void>;
}

export function weatherRepo(pool: Q): WeatherRepo {
    return {
        async listLocations(userId) {
            const r = await pool.query<WeatherLocationRow>(
                'SELECT * FROM weather_locations WHERE user_id = ? ORDER BY position ASC, created ASC',
                [userId]
            );
            return r.rows;
        },
        async findLocation(id, userId) {
            const r = await pool.query<WeatherLocationRow>(
                'SELECT * FROM weather_locations WHERE id = ? AND user_id = ?',
                [id, userId]
            );
            return r.rows[0] ?? null;
        },
        async createLocation({ userId, label, latitude, longitude, format, days, provider, apiKeyEnc }) {
            const id = randomUUID();
            const posRow = await pool.query<{ next: number }>(
                'SELECT COALESCE(MAX(position) + 1, 0) AS next FROM weather_locations WHERE user_id = ?',
                [userId]
            );
            const position = Number(posRow.rows[0]?.next ?? 0);
            // The first city a user adds is automatically their primary one.
            const isPrimary = position === 0 ? 1 : 0;
            await pool.query(
                `INSERT INTO weather_locations (id, user_id, label, latitude, longitude, format, days, provider, position, is_primary, api_key_enc)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [id, userId, label, latitude, longitude, format, days, provider, position, isPrimary, apiKeyEnc ?? null]
            );
            const r = await pool.query<WeatherLocationRow>('SELECT * FROM weather_locations WHERE id = ?', [id]);
            return r.rows[0];
        },
        async updateLocation(id, userId, patch) {
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
            if (sets.length === 0) return this.findLocation(id, userId);
            params.push(id, userId);
            const res = await pool.query(
                `UPDATE weather_locations SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`,
                params
            );
            if (res.rowCount === 0) return null;
            return this.findLocation(id, userId);
        },
        async deleteLocation(id, userId) {
            const target = await this.findLocation(id, userId);
            const r = await pool.query('DELETE FROM weather_locations WHERE id = ? AND user_id = ?', [id, userId]);
            if (r.rowCount === 0) return false;
            // If the primary city was removed, promote the first remaining one.
            if (target?.is_primary === 1) {
                const next = await this.listLocations(userId);
                if (next[0]) {
                    await pool.query('UPDATE weather_locations SET is_primary = 1 WHERE id = ? AND user_id = ?', [
                        next[0].id,
                        userId
                    ]);
                }
            }
            return true;
        },
        async reorderLocations(userId, ids) {
            // Assign each id its position by index; only rows owned by the user
            // are touched, so stray ids are silently ignored.
            for (let i = 0; i < ids.length; i++) {
                await pool.query('UPDATE weather_locations SET position = ? WHERE id = ? AND user_id = ?', [
                    i,
                    ids[i],
                    userId
                ]);
            }
            return this.listLocations(userId);
        },
        async setPrimaryLocation(userId, id) {
            await pool.query('UPDATE weather_locations SET is_primary = (id = ?) WHERE user_id = ?', [id, userId]);
            return this.listLocations(userId);
        },
        async getKey(userId, provider) {
            const r = await pool.query<WeatherProviderKeyRow>(
                'SELECT * FROM weather_provider_keys WHERE user_id = ? AND provider = ?',
                [userId, provider]
            );
            return r.rows[0] ?? null;
        },
        async setKey(userId, provider, keyEnc) {
            await pool.query(
                `INSERT INTO weather_provider_keys (user_id, provider, key_enc)
                 VALUES (?, ?, ?)
                 ON DUPLICATE KEY UPDATE key_enc = VALUES(key_enc)`,
                [userId, provider, keyEnc]
            );
        },
        async deleteKey(userId, provider) {
            await pool.query('DELETE FROM weather_provider_keys WHERE user_id = ? AND provider = ?', [
                userId,
                provider
            ]);
        }
    };
}
