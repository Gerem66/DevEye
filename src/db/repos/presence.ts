import type { PresenceEvent, PresenceRow } from 'deveye-types';
import type { Queryable } from '../pool';

type Q = Queryable;

export interface PresenceRepo {
    /** Record an online/offline transition (unix ms). */
    record(deviceId: string, ts: number, online: boolean): Promise<void>;
    /** Transitions within [from, to] for the device, ascending by ts. */
    query(deviceId: string, from: number, to: number): Promise<PresenceEvent[]>;
    /** Online state at `from`, carried over from the last transition before it. */
    onlineAt(deviceId: string, at: number): Promise<boolean>;
    pruneByRetention(defaultDays: number): Promise<number>;
}

export function presenceRepo(pool: Q): PresenceRepo {
    return {
        async record(deviceId, ts, online) {
            await pool.query('INSERT INTO device_presence (device_id, ts, online) VALUES (?, ?, ?)', [
                deviceId,
                ts,
                online ? 1 : 0
            ]);
        },
        async query(deviceId, from, to) {
            const r = await pool.query<PresenceRow>(
                `SELECT ts, online FROM device_presence
                 WHERE device_id = ? AND ts BETWEEN ? AND ?
                 ORDER BY ts ASC
                 LIMIT 5000`,
                [deviceId, from, to]
            );
            return r.rows.map((row) => ({ ts: Number(row.ts), online: row.online === 1 }));
        },
        async onlineAt(deviceId, at) {
            const r = await pool.query<PresenceRow>(
                `SELECT online FROM device_presence
                 WHERE device_id = ? AND ts <= ?
                 ORDER BY ts DESC
                 LIMIT 1`,
                [deviceId, at]
            );
            return r.rows[0] ? r.rows[0].online === 1 : false;
        },
        async pruneByRetention(defaultDays) {
            const r = await pool.query(
                `DELETE p FROM device_presence p
                 JOIN devices d ON d.id = p.device_id
                 WHERE d.status <> 'archived'
                   AND p.ts < (UNIX_TIMESTAMP() * 1000) - COALESCE(d.retention_days, ?) * 86400000`,
                [defaultDays]
            );
            return r.rowCount;
        }
    };
}
