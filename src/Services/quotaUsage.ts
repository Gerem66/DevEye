import type { SdkAccountQuotaUse, SdkAccountUsage } from '@deveye/types/sdk/server';

import type { Database } from '@/db';
import { planPauseCounts } from '@/Services/planPauses';

/**
 * Une limite que l'on sait mesurer pour un compte. `paused` n'est donné que
 * lorsque le miroir des pauses ne le compte pas dans l'unité de `used`.
 */
export interface UsageSource {
    fullKey: string;
    measure(
        ownerUserId: number,
        ownerWorkspaceIds: readonly number[]
    ): Promise<{ used: number | null; paused?: number }>;
}

/** Comptes mesurés à la fois : le reste du pool sert les membres pendant un relevé. */
const USAGE_PARALLEL = 4;

/** Ce qu'un compte utilise de chaque limite, sur les espaces qu'il possède. Une source en panne fait tout échouer. */
export async function usageOf(
    db: Pick<Database, 'workspaces'>,
    sources: readonly UsageSource[],
    ownerUserId: number
): Promise<SdkAccountUsage> {
    const owned = await db.workspaces.listOwnedIds(ownerUserId);
    const pausedCounts = planPauseCounts(ownerUserId);
    const quotas: Record<string, SdkAccountQuotaUse> = {};
    for (const source of sources) {
        let measured: { used: number | null; paused?: number };
        try {
            measured = await source.measure(ownerUserId, owned);
        } catch (e) {
            throw new Error(`Utilisation « ${source.fullKey} » illisible : ${(e as Error).message}`);
        }
        quotas[source.fullKey] = {
            used: measured.used,
            paused: measured.paused ?? pausedCounts[source.fullKey] ?? 0
        };
    }
    return { userId: ownerUserId, quotas };
}

/** `usageOf` pour plusieurs comptes, dans l'ordre donné, quelques-uns à la fois. */
export async function usagesOf(
    db: Pick<Database, 'workspaces'>,
    sources: readonly UsageSource[],
    ownerUserIds: readonly number[]
): Promise<SdkAccountUsage[]> {
    const out: SdkAccountUsage[] = new Array<SdkAccountUsage>(ownerUserIds.length);
    let next = 0;
    const worker = async (): Promise<void> => {
        while (next < ownerUserIds.length) {
            const i = next++;
            out[i] = await usageOf(db, sources, ownerUserIds[i]);
        }
    };
    await Promise.all(Array.from({ length: Math.min(USAGE_PARALLEL, ownerUserIds.length) }, worker));
    return out;
}
