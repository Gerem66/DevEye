import type { PresenceEvent, PresenceRow } from '@deveye/types';
import type { SdkQueryable } from '@deveye/types/sdk/server';

/**
 * La table `device_presence`, en lecture et en purge : les transitions
 * en ligne / hors ligne que la frise de disponibilité rejoue. L'écriture d'une
 * transition est le fait de la socket agent (`src/agent/ws.ts`), hors session.
 */
export interface PresenceRepo {
    /** Transitions within [from, to] for the device, ascending by ts. */
    query(deviceId: string, from: number, to: number): Promise<PresenceEvent[]>;
    /** Online state at `at`, carried over from the last transition before it. */
    onlineAt(deviceId: string, at: number): Promise<boolean>;
    /** Delete transitions past each device's retention (NULL → `defaultDays`). */
    pruneByRetention(defaultDays: number): Promise<number>;
}

export function presenceRepo(q: SdkQueryable): PresenceRepo {
    return {
        async query(deviceId, from, to) {
            const rows = await q.query<Pick<PresenceRow, 'ts' | 'online'>>(
                `SELECT ts, online FROM device_presence
                 WHERE device_id = ? AND ts BETWEEN ? AND ?
                 ORDER BY ts ASC
                 LIMIT 5000`,
                [deviceId, from, to]
            );
            return rows.map((row) => ({ ts: Number(row.ts), online: Number(row.online) === 1 }));
        },
        async onlineAt(deviceId, at) {
            const rows = await q.query<Pick<PresenceRow, 'online'>>(
                `SELECT online FROM device_presence
                 WHERE device_id = ? AND ts <= ?
                 ORDER BY ts DESC
                 LIMIT 1`,
                [deviceId, at]
            );
            return rows[0] ? Number(rows[0].online) === 1 : false;
        },
        async pruneByRetention(defaultDays) {
            const r = await q.execute(
                `DELETE p FROM device_presence p
                 JOIN devices d ON d.id = p.device_id
                 WHERE d.status <> 'archived'
                   AND p.ts < (UNIX_TIMESTAMP() * 1000) - COALESCE(d.retention_days, ?) * 86400000`,
                [defaultDays]
            );
            return r.affectedRows;
        }
    };
}
