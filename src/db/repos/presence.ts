import type { PresenceRow } from '@deveye/types';
import { selectColumns } from '../columns';
import type { Queryable } from '../pool';

type Q = Queryable;

type OnlineRow = Pick<PresenceRow, 'online'>;

const ONLINE_COLUMNS = selectColumns<OnlineRow>(null, { online: true });

/**
 * Le dépôt du socle : la transition enregistrée par la socket agent
 * (`agent/presence.ts`). La frise de disponibilité et la purge sont les
 * requêtes du module `features/devices`, sur cette même table.
 */
export interface PresenceRepo {
    /** Record an online/offline transition (unix ms). */
    record(deviceId: string, ts: number, online: boolean): Promise<void>;
    /** Online state at `from`, carried over from the last transition before it. */
    onlineAt(deviceId: string, at: number): Promise<boolean>;
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
        async onlineAt(deviceId, at) {
            const r = await pool.query<OnlineRow>(
                `SELECT ${ONLINE_COLUMNS} FROM device_presence
                 WHERE device_id = ? AND ts <= ?
                 ORDER BY ts DESC
                 LIMIT 1`,
                [deviceId, at]
            );
            return r.rows[0] ? r.rows[0].online === 1 : false;
        }
    };
}
