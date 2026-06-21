import type { ProcessKind, ProcessSample, ProcessSampleRow, ReportProcess } from 'deveye-types';
import type { Queryable } from '../pool';

type Q = Queryable;

/** Don't return a process sample further than this from the requested instant. */
const NEAREST_TOLERANCE_MS = 2 * 60 * 60 * 1000;

export interface ProcessSamplesRepo {
    insertSample(deviceId: string, sample: ProcessSample): Promise<void>;
    /** The process list captured nearest `at` (within tolerance), else null. */
    nearest(deviceId: string, at: number): Promise<ProcessSample | null>;
    /** Distinct snapshot timestamps within [from, to], ascending (timeline marks). */
    snapshotTimes(deviceId: string, from: number, to: number): Promise<number[]>;
    /** Delete samples past each device's process retention (NULL → default). */
    pruneByRetention(defaultDays: number): Promise<number>;
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
        async insertSample(deviceId, sample) {
            if (sample.processes.length === 0) return;
            const values = sample.processes.map(() => '(?, ?, ?, ?, ?, ?)').join(', ');
            const params: unknown[] = [];
            for (const p of sample.processes) {
                params.push(deviceId, sample.ts, sample.kind, p.name, p.cpuPercent, p.memBytes);
            }
            await pool.query(
                `INSERT INTO device_process_samples (device_id, ts, kind, name, cpu_percent, mem_bytes)
                 VALUES ${values}`,
                params
            );
        },
        async nearest(deviceId, at) {
            const ts = await nearestTs(deviceId, at);
            if (ts === null || Math.abs(ts - at) > NEAREST_TOLERANCE_MS) return null;
            const r = await pool.query<ProcessSampleRow>(
                `SELECT kind, name, cpu_percent, mem_bytes FROM device_process_samples
                 WHERE device_id = ? AND ts = ?
                 ORDER BY cpu_percent DESC`,
                [deviceId, ts]
            );
            if (r.rows.length === 0) return null;
            const kind = r.rows[0].kind as ProcessKind;
            const processes: ReportProcess[] = r.rows.map((row) => ({
                name: row.name,
                cpuPercent: Number(row.cpu_percent),
                memBytes: Number(row.mem_bytes)
            }));
            return { ts, kind, processes };
        },
        async snapshotTimes(deviceId, from, to) {
            const r = await pool.query<{ ts: number }>(
                `SELECT DISTINCT ts FROM device_process_samples
                 WHERE device_id = ? AND ts BETWEEN ? AND ?
                 ORDER BY ts ASC
                 LIMIT 5000`,
                [deviceId, from, to]
            );
            return r.rows.map((row) => Number(row.ts));
        },
        async pruneByRetention(defaultDays) {
            // Process history has its own (shorter) retention; it's the bulkiest data.
            const r = await pool.query(
                `DELETE s FROM device_process_samples s
                 JOIN devices d ON d.id = s.device_id
                 WHERE s.ts < (UNIX_TIMESTAMP() * 1000) - COALESCE(d.process_retention_days, ?) * 86400000`,
                [defaultDays]
            );
            return r.rowCount;
        }
    };
}
