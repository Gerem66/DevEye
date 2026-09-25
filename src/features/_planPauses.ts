import type { LiveTopic } from '@deveye/types';
import type { SdkStockItem } from '@deveye/types/sdk/server';

import type { Database } from '@/db';
import type { LiveHub } from '@/live/hub';
import {
    attachPlanPauses,
    createPlanPauses,
    type PlanPauseChange,
    type PlanPausesHost,
    type StockSource
} from '@/Services/planPauses';
import { planOfStrict } from '@/Services/quota';
import { invalidateAccess } from './_access';
import { moduleProvider, moduleStockSources, moduleWebDomainFeatures, notifyModulePlanPause } from './_sdk/register';

type Db = Pick<Database, 'workspaces' | 'workspaceMembers' | 'featureDomains'>;

/**
 * Les limites de stock que le cœur tient lui-même : les espaces partagés d'un
 * compte, leurs membres (par espace, le propriétaire jamais en pause, même à
 * 0) et ses noms de domaine web, rangés par première déclaration puis
 * développés en leurs lignes.
 */
export function coreStockSources(db: Db): StockSource[] {
    return [
        {
            fullKey: 'workspace.shared',
            featureId: null,
            overLimit: async (owner, _owned, limit) =>
                (await db.workspaces.listOwnedShared(owner))
                    .slice(limit)
                    .map((w) => ({ id: String(w.id), workspaceId: w.id }))
        },
        {
            fullKey: 'workspace.members',
            featureId: null,
            overLimit: async (owner, _owned, limit) => {
                const shared = await db.workspaces.listOwnedShared(owner);
                const members = await db.workspaceMembers.listByWorkspaceIds(shared.map((w) => w.id));
                const over: SdkStockItem[] = [];
                for (const { id: workspaceId } of shared) {
                    const ranked = members
                        .filter((m) => Number(m.workspace_id) === workspaceId)
                        .sort(
                            (a, b) =>
                                Number(b.user_id === owner) - Number(a.user_id === owner) ||
                                Number(a.date) - Number(b.date) ||
                                a.id - b.id
                        );
                    for (const m of ranked.slice(limit)) {
                        if (m.user_id !== owner) over.push({ id: `${workspaceId}:${m.user_id}`, workspaceId });
                    }
                }
                return over;
            }
        },
        {
            fullKey: 'domains.hosts',
            featureId: null,
            overLimit: async (_owner, owned, limit) => {
                const rows = await db.featureDomains.rowsOf(owned, moduleWebDomainFeatures());
                const paused = new Set([...new Set(rows.map((row) => row.host))].slice(limit));
                return rows
                    .filter((row) => paused.has(row.host))
                    .map((row) => ({ id: String(row.id), workspaceId: row.workspace_id }));
            }
        }
    ];
}

interface ApplyHost {
    db: Pick<Database, 'users' | 'workspaceMembers'>;
    live: Pick<LiveHub, 'changed' | 'userChanged' | 'evict'>;
}

/** Ce qu'une passe entraîne : les crochets des modules, l'accès des membres, et les écrans. */
export async function applyPlanPauseChanges(
    host: ApplyHost,
    owner: number,
    changes: readonly PlanPauseChange[]
): Promise<void> {
    const { db, live } = host;
    const accessChanges = changes.filter((c) => c.key === 'workspace.members' || c.key === 'workspace.shared');
    // Avant l'éviction : une commande qui arrive entre les deux doit déjà être refusée.
    if (accessChanges.length > 0) invalidateAccess();

    for (const change of changes) {
        const items = [...change.paused, ...change.resumed];
        const workspaces = new Set(items.map((item) => item.workspaceId));
        if (change.featureId) {
            const featureId = change.featureId;
            await notifyModulePlanPause(featureId, {
                key: change.key.slice(featureId.length + 1),
                paused: change.paused,
                resumed: change.resumed
            });
            for (const ws of workspaces) live.changed(ws, [featureId as LiveTopic], null);
        } else if (change.key === 'domains.hosts') {
            for (const ws of workspaces) live.changed(ws, ['domain'], null);
        }
    }

    for (const change of accessChanges) {
        for (const [items, paused] of [
            [change.paused, true],
            [change.resumed, false]
        ] as const) {
            for (const item of items) {
                const users =
                    change.key === 'workspace.members'
                        ? [Number(item.id.split(':')[1])]
                        : (await db.workspaceMembers.listByWorkspaceIds([item.workspaceId]))
                              .map((m) => m.user_id)
                              .filter((id) => id !== owner);
                for (const userId of users) {
                    if (paused) live.evict(item.workspaceId, userId);
                    // Assis ailleurs, il ne recevrait pas la diffusion de cet espace :
                    // son sélecteur doit griser l'entrée, ou la rendre.
                    live.userChanged(userId, item.workspaceId, ['workspace'], null);
                }
            }
            for (const ws of new Set(items.map((item) => item.workspaceId))) live.changed(ws, ['workspace'], null);
        }
    }

    // L'écran de l'offre dit ce qui est en pause.
    const account = await db.users.findById(owner);
    if (account) live.userChanged(owner, account.personal_workspace_id, ['account'], null);
}

/** Le service de l'hôte qui tient les pauses d'offre à jour. Démarré avant les modules, qui lisent le miroir. */
export function createPlanPausesService(host: { db: Database; logger: PlanPausesHost['logger']; live: LiveHub }): {
    start(): Promise<void>;
    stop(): Promise<void>;
} {
    const providers = { get: <T>(key: string) => moduleProvider<T>(key) };
    const engine = createPlanPauses({
        db: host.db,
        logger: host.logger,
        planOf: (userId) => planOfStrict(providers, userId),
        sources: () => [...moduleStockSources(host.db), ...coreStockSources(host.db)],
        applied: (owner, changes) => applyPlanPauseChanges(host, owner, changes)
    });
    attachPlanPauses(engine);
    return {
        start: () => engine.start(),
        stop: () => engine.stop()
    };
}
