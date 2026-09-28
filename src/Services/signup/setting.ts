import type { Database } from '@/db';

const SETTING = 'signups';

export interface StoredSignups {
    open: boolean;
    updated: number | null;
    updatedBy: { id: number; username: string } | null;
}

/** Les inscriptions de ce serveur. Aucune ligne, ou une valeur illisible, vaut fermé. */
export async function readSignups(db: Pick<Database, 'instanceSettings'>, origin: string): Promise<StoredSignups> {
    const row = await db.instanceSettings.get(SETTING, origin);
    if (!row) return { open: false, updated: null, updatedBy: null };
    return { open: row.value === 'open', updated: row.updated, updatedBy: row.updatedBy };
}

export async function writeSignups(
    db: Pick<Database, 'instanceSettings'>,
    origin: string,
    open: boolean,
    by: number
): Promise<void> {
    await db.instanceSettings.put(SETTING, origin, open ? 'open' : 'closed', by);
}
