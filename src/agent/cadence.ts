import { DEFAULT_METRIC_INTERVAL_SECONDS } from '@deveye/types';

import type { Database } from '@/db';
import { moduleProvider } from '@/features/_sdk/register';
import { logger } from '@/logger';
import { isPaidAccount } from '@/Services/quota';

interface CadenceRow {
    id: string;
    workspace_id: number | null;
    metric_interval_seconds: number | null;
}

/**
 * La cadence de collecte de chaque appareil : la sienne, ou le défaut de
 * l'offre du propriétaire de son espace (l'espace d'origine, pas celui qui le
 * regarde). Une lecture de l'offre par propriétaire, quel que soit le nombre
 * d'appareils.
 */
export async function metricIntervalsOf(
    db: Pick<Database, 'workspaces'>,
    rows: readonly CadenceRow[]
): Promise<Map<string, number>> {
    const paidByWorkspace = new Map<number, Promise<boolean>>();
    const paidIn = (workspaceId: number): Promise<boolean> => {
        let hit = paidByWorkspace.get(workspaceId);
        if (!hit) {
            hit = (async () => {
                const workspace = await db.workspaces.findById(workspaceId);
                if (!workspace) return false;
                return isPaidAccount(
                    { get: <T>(key: string) => moduleProvider<T>(key) },
                    workspace.owner_user_id,
                    logger
                );
            })();
            paidByWorkspace.set(workspaceId, hit);
        }
        return hit;
    };
    const out = new Map<string, number>();
    for (const row of rows) {
        if (row.metric_interval_seconds !== null) {
            out.set(row.id, Number(row.metric_interval_seconds));
            continue;
        }
        // Sans espace (supprimé), l'appareil ne tourne plus : la cadence la moins chère.
        const paid = row.workspace_id === null ? false : await paidIn(row.workspace_id);
        out.set(row.id, DEFAULT_METRIC_INTERVAL_SECONDS[paid ? 'paid' : 'free']);
    }
    return out;
}

export async function metricIntervalOf(db: Pick<Database, 'workspaces'>, row: CadenceRow): Promise<number> {
    return (await metricIntervalsOf(db, [row])).get(row.id) as number;
}
