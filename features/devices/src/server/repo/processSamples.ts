import { gunzip, gzip } from 'node:zlib';
import { promisify } from 'node:util';

import { reportProcessSchema, type ProcessKind, type ProcessSample, type ReportProcess } from '@deveye/types';
import type { SdkQueryable } from '@deveye/types/sdk/server';

const gunzipAsync = promisify(gunzip);
const gzipAsync = promisify(gzip);

/**
 * Don't return a process sample further than this from the requested instant:
 * metric rows and process samples share the same `ts`, so this only absorbs an
 * instant falling between two stored ones.
 */
const NEAREST_TOLERANCE_MS = 5 * 60 * 1000;

/** Aligné sur `MAX_INSTANT_MARKS` du dépôt des métriques (voir son commentaire). */
const MAX_SNAPSHOT_MARKS = 20_000;

/** One stored instant: the process list lives in `payload` as gzipped JSON. */
interface ProcessSampleRow {
    ts: number;
    kind: ProcessKind;
    payload: Buffer;
}

export interface SnapshotStorage {
    /** Snapshot instants stored (one row each). */
    snapshots: number;
    /** Total process entries recorded across those instants. */
    processes: number;
    /** Bytes the compressed blobs occupy: measured, not estimated. */
    bytes: number;
}

/**
 * La table `device_process_samples`, en lecture et en entretien. L'insertion
 * (le blob gzip, mesuré à l'écriture) est le fait de l'ingestion, hors session.
 */
export interface ProcessSampleRepo {
    /** The process list captured nearest `at` (within tolerance), else null. */
    nearest(deviceId: string, at: number): Promise<ProcessSample | null>;
    /** Snapshot timestamps within [from, to], ascending (the instants that carry a list). */
    snapshotTimes(deviceId: string, from: number, to: number): Promise<{ timestamps: number[]; pinned: number[] }>;
    /** Storage taken by a device's stored snapshots. */
    storage(deviceId: string): Promise<SnapshotStorage>;
    /** Delete snapshots whose `ts` falls in [from, to] (inclusive). */
    deleteRange(deviceId: string, from: number, to: number): Promise<{ snapshots: number }>;
    /**
     * Delete unpinned instants in [from, to] already past the device's
     * retention (used right after unpinning). Returns instants removed.
     */
    deleteExpiredInRange(
        deviceId: string,
        from: number,
        to: number,
        defaultDays: number
    ): Promise<{ snapshots: number }>;
    /** Delete samples past each device's retention (NULL → default); skips pinned. */
    pruneByRetention(defaultDays: number): Promise<number>;
    /**
     * Cut unpinned full lists older than `before` (ms) down to their first
     * `keep` entries, oldest first, at most `limit` instants. Returns how many
     * were cut: fewer than `limit` means none is left.
     */
    thinBefore(before: number, keep: number, limit: number): Promise<number>;
}

export function processSampleRepo(q: SdkQueryable): ProcessSampleRepo {
    async function nearestTs(deviceId: string, at: number): Promise<number | null> {
        const [before, after] = await Promise.all([
            q.query<{ ts: number }>(
                'SELECT ts FROM device_process_samples WHERE device_id = ? AND ts <= ? ORDER BY ts DESC LIMIT 1',
                [deviceId, at]
            ),
            q.query<{ ts: number }>(
                'SELECT ts FROM device_process_samples WHERE device_id = ? AND ts >= ? ORDER BY ts ASC LIMIT 1',
                [deviceId, at]
            )
        ]);
        const b = before[0] ? Number(before[0].ts) : null;
        const a = after[0] ? Number(after[0].ts) : null;
        if (b === null) return a;
        if (a === null) return b;
        return at - b <= a - at ? b : a;
    }

    return {
        async nearest(deviceId, at) {
            const ts = await nearestTs(deviceId, at);
            if (ts === null || Math.abs(ts - at) > NEAREST_TOLERANCE_MS) return null;
            const rows = await q.query<ProcessSampleRow>(
                'SELECT ts, kind, payload FROM device_process_samples WHERE device_id = ? AND ts = ?',
                [deviceId, ts]
            );
            const row = rows[0];
            if (!row) return null;
            // A blob that fails to inflate or parse is corrupt storage: report
            // "no sample" rather than breaking the panel.
            let processes: ReportProcess[];
            try {
                const json = (await gunzipAsync(row.payload)).toString('utf8');
                processes = reportProcessSchema.array().parse(JSON.parse(json));
            } catch {
                return null;
            }
            return { ts, kind: row.kind, processes };
        },
        async snapshotTimes(deviceId, from, to) {
            // Même plafond et même sens que `metrics.instantTimes` : les plus
            // récents d'abord, remis dans l'ordre ensuite.
            const rows = await q.query<{ ts: number; pinned: number }>(
                `SELECT ts, pinned FROM device_process_samples
                 WHERE device_id = ? AND ts BETWEEN ? AND ?
                 ORDER BY ts DESC
                 LIMIT ${MAX_SNAPSHOT_MARKS}`,
                [deviceId, from, to]
            );
            const timestamps: number[] = [];
            const pinned: number[] = [];
            for (const row of rows.reverse()) {
                const ts = Number(row.ts);
                timestamps.push(ts);
                if (Number(row.pinned) === 1) pinned.push(ts);
            }
            return { timestamps, pinned };
        },
        async storage(deviceId) {
            const rows = await q.query<{ snapshots: number; processes: number; bytes: number }>(
                `SELECT COUNT(*)                          AS snapshots,
                        COALESCE(SUM(proc_count), 0)      AS processes,
                        COALESCE(SUM(payload_bytes), 0)   AS bytes
                 FROM device_process_samples WHERE device_id = ?`,
                [deviceId]
            );
            const row = rows[0];
            return {
                snapshots: Number(row?.snapshots ?? 0),
                processes: Number(row?.processes ?? 0),
                bytes: Number(row?.bytes ?? 0)
            };
        },
        async deleteRange(deviceId, from, to) {
            const del = await q.execute(
                'DELETE FROM device_process_samples WHERE device_id = ? AND ts BETWEEN ? AND ?',
                [deviceId, from, to]
            );
            return { snapshots: del.affectedRows };
        },
        async deleteExpiredInRange(deviceId, from, to, defaultDays) {
            const del = await q.execute(
                `DELETE s FROM device_process_samples s
                 JOIN devices d ON d.id = s.device_id
                 WHERE s.device_id = ? AND s.ts BETWEEN ? AND ?
                   AND s.pinned = 0 AND d.status <> 'archived'
                   AND s.ts < (UNIX_TIMESTAMP() * 1000) - COALESCE(d.retention_days, ?) * 86400000`,
                [deviceId, from, to, defaultDays]
            );
            return { snapshots: del.affectedRows };
        },
        async pruneByRetention(defaultDays) {
            // Même échéance que les métriques et la présence : un relevé est un
            // instant. Les lignes épinglées survivent quel que soit leur âge.
            const r = await q.execute(
                `DELETE s FROM device_process_samples s
                 JOIN devices d ON d.id = s.device_id
                 WHERE s.pinned = 0
                   AND d.status <> 'archived'
                   AND s.ts < (UNIX_TIMESTAMP() * 1000) - COALESCE(d.retention_days, ?) * 86400000`,
                [defaultDays]
            );
            return r.affectedRows;
        },
        async thinBefore(before, keep, limit) {
            const rows = await q.query<{ device_id: string; ts: number; payload: Buffer }>(
                `SELECT device_id, ts, payload FROM device_process_samples
                 WHERE kind = 'all' AND pinned = 0 AND ts < ?
                 ORDER BY ts ASC
                 LIMIT ${Math.max(1, Math.floor(limit))}`,
                [before]
            );
            for (const row of rows) {
                // L'agent envoie sa liste classée par CPU + part de mémoire, et
                // l'ingestion la garde dans cet ordre : ses premières lignes sont
                // exactement le top qu'il aurait envoyé. Un blob illisible le
                // reste, marqué pour ne pas être relu à chaque passe.
                let top: unknown[] | null = null;
                try {
                    const all = JSON.parse((await gunzipAsync(row.payload)).toString('utf8')) as unknown;
                    if (Array.isArray(all)) top = all.slice(0, keep);
                } catch {
                    top = null;
                }
                if (top === null) {
                    await q.execute(
                        `UPDATE device_process_samples SET kind = 'top'
                         WHERE device_id = ? AND ts = ? AND kind = 'all' AND pinned = 0`,
                        [row.device_id, row.ts]
                    );
                    continue;
                }
                const payload = await gzipAsync(Buffer.from(JSON.stringify(top), 'utf8'));
                // `pinned = 0` revérifié : un instant épinglé entre-temps garde sa liste.
                await q.execute(
                    `UPDATE device_process_samples
                        SET kind = 'top', proc_count = ?, payload_bytes = ?, payload = ?
                      WHERE device_id = ? AND ts = ? AND kind = 'all' AND pinned = 0`,
                    [top.length, payload.length, payload, row.device_id, row.ts]
                );
            }
            return rows.length;
        }
    };
}
