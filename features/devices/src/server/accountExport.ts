import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';

import type { FeatureAccountExport, SdkQueryable } from '@deveye/types/sdk/server';

import type { DevicesRepo } from './repo';

const gunzipAsync = promisify(gunzip);

const OF_DEVICES = 'device_id IN (SELECT id FROM devices WHERE workspace_id = ?)';

/** Une liste complète pèse plusieurs centaines de ko décompressée : peu à la fois. */
const PROCESS_PAGE = 50;

/** Les listes de processus d'un espace, décompressées, appareil par appareil dans l'ordre du temps. */
export async function* processLists(
    q: SdkQueryable,
    workspaceId: number,
    signal: AbortSignal
): AsyncGenerator<Record<string, unknown>> {
    const devices = await q.query<{ id: string }>('SELECT id FROM devices WHERE workspace_id = ? ORDER BY id', [
        workspaceId
    ]);
    for (const { id } of devices) {
        let after = -1;
        for (;;) {
            signal.throwIfAborted();
            const rows = await q.query<{ ts: number; kind: string; pinned: number; payload: Uint8Array }>(
                `SELECT ts, kind, pinned, payload FROM device_process_samples
                  WHERE device_id = ? AND ts > ? ORDER BY ts LIMIT ${PROCESS_PAGE}`,
                [id, after]
            );
            for (const row of rows) {
                let processes: unknown = null;
                try {
                    processes = JSON.parse((await gunzipAsync(row.payload)).toString('utf8'));
                } catch {
                    // Un blob corrompu reste vide : l'instant garde sa place dans la série.
                }
                yield {
                    device_id: id,
                    ts: new Date(Number(row.ts)).toISOString(),
                    kind: row.kind,
                    pinned: Number(row.pinned) === 1,
                    processes
                };
            }
            if (rows.length < PROCESS_PAGE) break;
            after = Number(rows[rows.length - 1].ts);
        }
    }
}

export const devicesAccountExport: FeatureAccountExport<DevicesRepo> = {
    tables: {
        devices: {
            file: 'appareils.json',
            where: 'workspace_id = ?',
            key: ['id'],
            json: ['report_json'],
            dates: { last_seen: 's', created: 's' },
            omit: ['token_hash', 'token_hash_prev']
        },
        device_metrics: {
            file: 'mesures.json',
            where: OF_DEVICES,
            key: ['id'],
            dates: { ts: 'ms' }
        },
        device_presence: {
            file: 'connexions.json',
            where: OF_DEVICES,
            key: ['id'],
            dates: { ts: 'ms' }
        },
        // Un blob gzip par instant : décompressé par `workspace`, s'il est gardé.
        device_process_samples: 'custom',
        device_link_codes: { skip: 'Les codes d’appairage ne servent qu’une fois, puis expirent.' }
    },
    files: {
        processes: {
            label: 'les relevés de processus des appareils',
            optional: true,
            async bytes({ q, workspaceIds }) {
                if (workspaceIds.length === 0) return 0;
                const rows = await q.query<{ n: number | string }>(
                    `SELECT COALESCE(SUM(s.payload_bytes), 0) AS n FROM device_process_samples s
                       JOIN devices d ON d.id = s.device_id WHERE d.workspace_id IN (?)`,
                    [workspaceIds]
                );
                return Number(rows[0]?.n ?? 0);
            }
        }
    },
    async workspace(ctx) {
        if (!ctx.includes('processes')) return;
        await ctx.out.rows('processus.json', processLists(ctx.q, ctx.workspace.id, ctx.signal));
    }
};
