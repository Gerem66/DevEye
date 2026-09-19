import type { WeatherFormat, WeatherLocationRow, WeatherProvider, WeatherProviderKeyRow } from '../contracts/domain';
import type { SdkQueryable } from '@deveye/types/sdk/server';
import { randomUUID } from 'crypto';

export interface CreateWeatherLocationInput {
    userId: number;
    workspaceId: number;
    label: string;
    latitude: number;
    longitude: number;
    format: WeatherFormat;
    days: number;
    provider: WeatherProvider;
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
        }
    ): Promise<WeatherLocationRow | null>;
    deleteLocation(id: string, workspaceId: number): Promise<boolean>;
    /** Passer d'un fournisseur à un autre toutes les villes de l'espace qui y sont ; rend leur nombre. */
    moveLocations(workspaceId: number, from: WeatherProvider, to: WeatherProvider): Promise<number>;
    /** Réordonner : chaque id prend pour `position` son rang dans `ids`. */
    reorderLocations(workspaceId: number, ids: string[]): Promise<WeatherLocationRow[]>;
    /** Faire de `id` la ville principale de l'espace, à la place de celle qui l'était. */
    setPrimaryLocation(workspaceId: number, id: string): Promise<WeatherLocationRow[]>;
    getKey(workspaceId: number, provider: WeatherProvider): Promise<WeatherProviderKeyRow | null>;
    /** Les fournisseurs pour lesquels l'espace détient une clé. */
    listKeyProviders(workspaceId: number): Promise<WeatherProvider[]>;
    setKey(workspaceId: number, provider: WeatherProvider, keyEnc: string): Promise<void>;
    deleteKey(workspaceId: number, provider: WeatherProvider): Promise<void>;
}

export function createRepo(q: SdkQueryable): WeatherRepo {
    return {
        async listLocations(workspaceId) {
            return q.query<WeatherLocationRow>(
                'SELECT * FROM weather_locations WHERE workspace_id = ? ORDER BY position ASC, created ASC',
                [workspaceId]
            );
        },
        async findLocation(id, workspaceId) {
            const rows = await q.query<WeatherLocationRow>(
                'SELECT * FROM weather_locations WHERE id = ? AND workspace_id = ?',
                [id, workspaceId]
            );
            return rows[0] ?? null;
        },
        async createLocation({ userId, workspaceId, label, latitude, longitude, format, days, provider }) {
            const id = randomUUID();
            const posRows = await q.query<{ next: number }>(
                'SELECT COALESCE(MAX(position) + 1, 0) AS next FROM weather_locations WHERE workspace_id = ?',
                [workspaceId]
            );
            const position = Number(posRows[0]?.next ?? 0);
            // La première ville d'un espace est d'office sa principale.
            const isPrimary = position === 0 ? 1 : 0;
            await q.execute(
                `INSERT INTO weather_locations (id, user_id, workspace_id, label, latitude, longitude, format, days, provider, position, is_primary)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [id, userId, workspaceId, label, latitude, longitude, format, days, provider, position, isPrimary]
            );
            const rows = await q.query<WeatherLocationRow>('SELECT * FROM weather_locations WHERE id = ?', [id]);
            return rows[0];
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
            if (sets.length === 0) return this.findLocation(id, workspaceId);
            params.push(id, workspaceId);
            const res = await q.execute(
                `UPDATE weather_locations SET ${sets.join(', ')} WHERE id = ? AND workspace_id = ?`,
                params
            );
            if (res.affectedRows === 0) return null;
            return this.findLocation(id, workspaceId);
        },
        async deleteLocation(id, workspaceId) {
            const target = await this.findLocation(id, workspaceId);
            const res = await q.execute('DELETE FROM weather_locations WHERE id = ? AND workspace_id = ?', [
                id,
                workspaceId
            ]);
            if (res.affectedRows === 0) return false;
            // La principale vient de partir : la première qui reste la remplace.
            if (target?.is_primary === 1) {
                const next = await this.listLocations(workspaceId);
                if (next[0]) {
                    await q.execute('UPDATE weather_locations SET is_primary = 1 WHERE id = ? AND workspace_id = ?', [
                        next[0].id,
                        workspaceId
                    ]);
                }
            }
            return true;
        },
        async moveLocations(workspaceId, from, to) {
            const res = await q.execute(
                'UPDATE weather_locations SET provider = ? WHERE workspace_id = ? AND provider = ?',
                [to, workspaceId, from]
            );
            return res.affectedRows;
        },
        async reorderLocations(workspaceId, ids) {
            // Seules les lignes de l'espace sont touchées : un id étranger ne fait rien.
            for (let i = 0; i < ids.length; i++) {
                await q.execute('UPDATE weather_locations SET position = ? WHERE id = ? AND workspace_id = ?', [
                    i,
                    ids[i],
                    workspaceId
                ]);
            }
            return this.listLocations(workspaceId);
        },
        async setPrimaryLocation(workspaceId, id) {
            await q.execute('UPDATE weather_locations SET is_primary = (id = ?) WHERE workspace_id = ?', [
                id,
                workspaceId
            ]);
            return this.listLocations(workspaceId);
        },
        async getKey(workspaceId, provider) {
            const rows = await q.query<WeatherProviderKeyRow>(
                'SELECT * FROM weather_provider_keys WHERE workspace_id = ? AND provider = ?',
                [workspaceId, provider]
            );
            return rows[0] ?? null;
        },
        async listKeyProviders(workspaceId) {
            const rows = await q.query<{ provider: WeatherProvider }>(
                'SELECT provider FROM weather_provider_keys WHERE workspace_id = ?',
                [workspaceId]
            );
            return rows.map((row) => row.provider);
        },
        async setKey(workspaceId, provider, keyEnc) {
            await q.execute(
                `INSERT INTO weather_provider_keys (workspace_id, provider, key_enc)
                 VALUES (?, ?, ?)
                 ON DUPLICATE KEY UPDATE key_enc = VALUES(key_enc)`,
                [workspaceId, provider, keyEnc]
            );
        },
        async deleteKey(workspaceId, provider) {
            await q.execute('DELETE FROM weather_provider_keys WHERE workspace_id = ? AND provider = ?', [
                workspaceId,
                provider
            ]);
        }
    };
}
