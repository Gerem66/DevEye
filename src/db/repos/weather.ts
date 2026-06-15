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
}

export interface WeatherRepo {
    listLocations(userId: number): Promise<WeatherLocationRow[]>;
    findLocation(id: string, userId: number): Promise<WeatherLocationRow | null>;
    createLocation(input: CreateWeatherLocationInput): Promise<WeatherLocationRow>;
    updateLocation(
        id: string,
        userId: number,
        patch: { format?: WeatherFormat; days?: number; position?: number }
    ): Promise<WeatherLocationRow | null>;
    deleteLocation(id: string, userId: number): Promise<boolean>;
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
        async createLocation({ userId, label, latitude, longitude, format, days, provider }) {
            const id = randomUUID();
            const posRow = await pool.query<{ next: number }>(
                'SELECT COALESCE(MAX(position) + 1, 0) AS next FROM weather_locations WHERE user_id = ?',
                [userId]
            );
            const position = Number(posRow.rows[0]?.next ?? 0);
            await pool.query(
                `INSERT INTO weather_locations (id, user_id, label, latitude, longitude, format, days, provider, position)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [id, userId, label, latitude, longitude, format, days, provider, position]
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
            const r = await pool.query('DELETE FROM weather_locations WHERE id = ? AND user_id = ?', [id, userId]);
            return r.rowCount > 0;
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
