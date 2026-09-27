import type { SdkAccountUsage } from '@deveye/types/sdk/server';

import type { Database } from '@/db';
import { isPlanPaused } from '@/Services/planPauses';
import { assertPlanLimit, limitIn, ownedWorkspaceIds, planOf, type PlanLimitCheck } from '@/Services/quota';
import { usagesOf, type UsageSource } from '@/Services/quotaUsage';
import type { FeatureContext } from './_define';
import { moduleProvider, moduleUsageSources, moduleWebDomainFeatures } from './_sdk/register';

const providers = { get: <T>(key: string) => moduleProvider<T>(key) };

/**
 * Ce que le cœur borne lui-même, sans manifest : les espaces partagés d'un
 * compte, leurs membres et leurs domaines web. Mêmes règles que les quotas des
 * modules, et même absence de limite sans module d'offre installé.
 */
export function assertCoreLimit(ctx: FeatureContext, check: PlanLimitCheck): Promise<void> {
    return assertPlanLimit(ctx.db, providers, ctx.logger, check);
}

/**
 * Ce qu'un écran annonce avant le refus : la limite d'une clé du cœur pour ce
 * compte, et les espaces sur lesquels elle se compte. `null` : illimitée.
 */
export async function coreAllowance(
    ctx: FeatureContext,
    ownerUserId: number,
    fullKey: string
): Promise<{ limit: number; ownerWorkspaceIds: number[] } | null> {
    const limit = limitIn(await planOf(providers, ownerUserId, ctx.logger), fullKey);
    if (limit === null) return null;
    return { limit, ownerWorkspaceIds: await ownedWorkspaceIds(ctx.db, ownerUserId) };
}

/**
 * Ce que compte chaque limite du cœur, sous la règle de sa garde : les membres
 * valent par espace, donc l'espace le plus peuplé (propriétaire compris), et
 * un domaine compte par nom, quelle que soit la feature qui le sert.
 */
export function coreUsageSources(
    db: Pick<Database, 'workspaces' | 'workspaceMembers' | 'featureDomains'>
): UsageSource[] {
    return [
        {
            fullKey: 'workspace.shared',
            measure: async (owner) => ({ used: (await db.workspaces.listOwnedShared(owner)).length })
        },
        {
            fullKey: 'workspace.members',
            measure: async (owner) => {
                const shared = await db.workspaces.listOwnedShared(owner);
                if (shared.length === 0) return { used: 0, paused: 0 };
                const members = await db.workspaceMembers.listByWorkspaceIds(shared.map((w) => w.id));
                let used = 0;
                let paused = 0;
                for (const { id } of shared) {
                    const here = members.filter((m) => Number(m.workspace_id) === id);
                    if (here.length <= used) continue;
                    used = here.length;
                    paused = here.filter((m) => isPlanPaused('workspace.members', `${id}:${m.user_id}`)).length;
                }
                return { used, paused };
            }
        },
        {
            fullKey: 'domains.hosts',
            measure: async (_owner, owned) => {
                const rows = await db.featureDomains.rowsOf(owned, moduleWebDomainFeatures());
                const paused = rows.filter((row) => isPlanPaused('domains.hosts', String(row.id)));
                return {
                    used: new Set(rows.map((row) => row.host)).size,
                    paused: new Set(paused.map((row) => row.host)).size
                };
            }
        }
    ];
}

/** Ce qu'utilisent ces comptes, modules et cœur ensemble, dans l'ordre donné ; un compte inconnu est omis. */
export async function accountUsages(db: Database, userIds: readonly number[]): Promise<SdkAccountUsage[]> {
    const unique = [...new Set(userIds)];
    if (unique.length === 0) return [];
    const known = new Set((await db.users.findByIds(unique)).map((u) => u.id));
    return usagesOf(
        db,
        [...moduleUsageSources(db), ...coreUsageSources(db)],
        unique.filter((id) => known.has(id))
    );
}
