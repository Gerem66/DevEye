import { gunzip, gzip } from 'node:zlib';
import { promisify } from 'node:util';

import { reportProcessSchema, type ProcessKind, type ProcessSample, type ReportProcess } from '@deveye/types';
import type { Queryable } from '../pool';

type Q = Queryable;

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/**
 * Don't return a process sample further than this from the requested instant.
 * Metric rows and process samples share the same `ts`, so this only absorbs a
 * requested instant falling between two stored ones.
 */
const NEAREST_TOLERANCE_MS = 5 * 60 * 1000;

/** One stored instant: the process list lives in `payload` as gzipped JSON. */
export interface ProcessSampleRow {
    ts: number;
    kind: ProcessKind;
    payload: Buffer;
}

/**
 * Le dépôt du socle : l'ingestion (`insertSample`) et l'instant le plus proche
 * (`nearest`), poussé à l'ouverture d'un abonnement et lu par la façade
 * `telemetry`. La frise, l'empreinte de stockage et les purges sont les
 * requêtes du module `features/devices`, sur cette même table.
 */
export interface ProcessSamplesRepo {
    /**
     * Store the process list captured at `ts`. The timestamp comes from the
     * metric snapshot it travelled with, so a graph point and its processes are
     * always keyed identically. Re-sending an instant overwrites it.
     */
    insertSample(deviceId: string, ts: number, kind: ProcessKind, processes: ReportProcess[]): Promise<void>;
    /** The process list captured nearest `at` (within tolerance), else null. */
    nearest(deviceId: string, at: number): Promise<ProcessSample | null>;
}

export function processSamplesRepo(pool: Q): ProcessSamplesRepo {
    async function nearestTs(deviceId: string, at: number): Promise<number | null> {
        const [before, after] = await Promise.all([
            pool.query<{ ts: number }>(
                'SELECT ts FROM device_process_samples WHERE device_id = ? AND ts <= ? ORDER BY ts DESC LIMIT 1',
                [deviceId, at]
            ),
            pool.query<{ ts: number }>(
                'SELECT ts FROM device_process_samples WHERE device_id = ? AND ts >= ? ORDER BY ts ASC LIMIT 1',
                [deviceId, at]
            )
        ]);
        const b = before.rows[0] ? Number(before.rows[0].ts) : null;
        const a = after.rows[0] ? Number(after.rows[0].ts) : null;
        if (b === null) return a;
        if (a === null) return b;
        return at - b <= a - at ? b : a;
    }

    return {
        async insertSample(deviceId, ts, kind, processes) {
            if (processes.length === 0) return;
            const payload = await gzipAsync(Buffer.from(JSON.stringify(processes), 'utf8'));
            // `payload_bytes` est mesuré ici une fois pour toutes : le calculer
            // à la lecture obligeait `storage()` à relire chaque blob hors page.
            await pool.query(
                `INSERT INTO device_process_samples (device_id, ts, kind, proc_count, payload_bytes, payload)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE kind = VALUES(kind), proc_count = VALUES(proc_count),
                                         payload_bytes = VALUES(payload_bytes), payload = VALUES(payload)`,
                [deviceId, ts, kind, processes.length, payload.length, payload]
            );
        },
        async nearest(deviceId, at) {
            const ts = await nearestTs(deviceId, at);
            if (ts === null || Math.abs(ts - at) > NEAREST_TOLERANCE_MS) return null;
            const r = await pool.query<ProcessSampleRow>(
                'SELECT ts, kind, payload FROM device_process_samples WHERE device_id = ? AND ts = ?',
                [deviceId, ts]
            );
            const row = r.rows[0];
            if (!row) return null;
            // A blob that fails to inflate or parse is corrupt storage, not a
            // client error: report "no sample" rather than breaking the panel.
            let processes: ReportProcess[];
            try {
                const json = (await gunzipAsync(row.payload)).toString('utf8');
                processes = reportProcessSchema.array().parse(JSON.parse(json));
            } catch {
                return null;
            }
            return { ts, kind: row.kind, processes };
        }
    };
}
