import { z } from 'zod';

import type { Database } from '@/db';

const SETTING = 'selfTracking';

/** Le site d'une page publique, mesuré par la balise ; absent tant qu'il n'est pas déclaré. */
const companionSchema = z.object({
    key: z.string().min(1),
    siteId: z.number().int().positive()
});

const configSchema = z.object({
    key: z.string().min(1),
    siteId: z.number().int().positive(),
    workspaceId: z.number().int().positive(),
    enabled: z.boolean(),
    excludeAdmins: z.boolean(),
    status: companionSchema.optional(),
    site: companionSchema.optional()
});

export type TrackingConfig = z.infer<typeof configSchema>;
export type TrackingCompanionKind = 'status' | 'site';

export interface StoredTracking {
    config: TrackingConfig;
    updated: number;
    updatedBy: { id: number; username: string } | null;
}

function parse(value: string): TrackingConfig | null {
    try {
        const parsed = configSchema.safeParse(JSON.parse(value));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

/** Le réglage de ce serveur ; un réglage illisible vaut aucun. */
export async function readTracking(
    db: Pick<Database, 'instanceSettings'>,
    origin: string
): Promise<StoredTracking | null> {
    const row = await db.instanceSettings.get(SETTING, origin);
    const config = row && parse(row.value);
    return config ? { config, updated: row.updated, updatedBy: row.updatedBy } : null;
}

export async function writeTracking(
    db: Pick<Database, 'instanceSettings'>,
    origin: string,
    config: TrackingConfig,
    by: number
): Promise<void> {
    await db.instanceSettings.put(SETTING, origin, JSON.stringify(config), by);
}

export async function clearTracking(db: Pick<Database, 'instanceSettings'>, origin: string): Promise<void> {
    await db.instanceSettings.remove(SETTING, origin);
}

/** Les réglages des autres serveurs qui partagent cette base. */
export async function otherTrackings(
    db: Pick<Database, 'instanceSettings'>,
    origin: string
): Promise<{ origin: string; enabled: boolean }[]> {
    return (await db.instanceSettings.listByName(SETTING))
        .filter((row) => row.origin !== origin)
        .map((row) => ({ origin: row.origin, enabled: parse(row.value)?.enabled ?? false }));
}
