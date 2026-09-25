import type { AccountPlan } from '@deveye/types/sdk';
import type { SdkPlanPauseChange, SdkStockItem } from '@deveye/types/sdk/server';

import type { Database } from '@/db';

/**
 * Les limites de stock (`Docs/QUOTAS.md`) : ce qui dépasse la limite de l'offre
 * de son propriétaire, les plus récents d'abord, est tenu en pause, et repart
 * dès que la limite remonte ou qu'une place se libère. `quota_pauses` est la
 * vérité ; le miroir en mémoire la sert aux chemins chauds (une sonde, une
 * trame d'agent), et ne change qu'après une écriture validée.
 */

export interface StockSource {
    /** `<featureId>.<quotaKey>`, ou une clé du cœur (`workspace.members`). */
    fullKey: string;
    /** Le module qui la tient, `null` pour le cœur. */
    featureId: string | null;
    /** Ce qui dépasse `limit` parmi ce que la clé compte sur les espaces du propriétaire. */
    overLimit(
        ownerUserId: number,
        ownerWorkspaceIds: readonly number[],
        limit: number
    ): Promise<readonly SdkStockItem[]>;
}

/** Ce qu'une passe a changé pour une clé. `key` est la clé complète. */
export interface PlanPauseChange extends SdkPlanPauseChange {
    featureId: string | null;
}

export interface PlanPausesHost {
    db: Pick<Database, 'quotaPauses' | 'workspaces' | 'transaction'>;
    logger: { warn(obj: object, msg: string): void; error(obj: object, msg: string): void };
    /** Jamais d'un cache. `null` : aucun fournisseur, donc aucune limite. Lève quand le fournisseur lève. */
    planOf(userId: number): Promise<AccountPlan | null>;
    sources(): readonly StockSource[];
    /** Les effets de ce qu'une passe vient d'écrire : crochets des modules, accès, diffusion. */
    applied(ownerUserId: number, changes: readonly PlanPauseChange[]): Promise<void>;
    now?(): number;
}

export interface PlanPauses {
    /** Charge le miroir, oublie les clés qu'aucune source ne tient plus, et passe sur tous les propriétaires. */
    start(): Promise<void>;
    stop(): Promise<void>;
    isPaused(fullKey: string, itemId: string): boolean;
    paused(fullKey: string): string[];
    /** Par clé complète, seulement celles qui en ont. */
    countsOf(ownerUserId: number): Record<string, number>;
    /** Le propriétaire a-t-il quelque chose en pause sous une clé de ce module ? */
    hasPausesIn(ownerUserId: number, featureId: string): boolean;
    /** Une passe pour ce compte, bientôt, avant le balayage de fond. */
    schedule(ownerUserId: number): void;
    /** Une passe, tout de suite. */
    reconcile(ownerUserId: number): Promise<void>;
    /** L'offre de ce compte change d'elle-même à cet instant (ms) : une passe l'attend. */
    noteChangesAt(userId: number, at: number | undefined): void;
}

/** Assez pour regrouper les déclencheurs d'un même geste (le webhook, puis la commande). */
const DEBOUNCE_MS = 500;
const RECHECK_EVERY_MS = 60_000;
const SWEEP_EVERY_MS = 60 * 60_000;
/** Le filet de ce qu'aucun déclencheur n'a vu : un chemin qui fait revenir un élément sans compter. */
const SWEEP_ALL_EVERY_MS = 24 * 60 * 60_000;

interface MirrorEntry {
    owner: number;
    workspaceId: number;
}

export function createPlanPauses(host: PlanPausesHost): PlanPauses {
    const { db, logger } = host;
    const now = host.now ?? Date.now;
    const mirror = new Map<string, Map<string, MirrorEntry>>();
    const byOwner = new Map<number, Map<string, number>>();
    const recheckKnown = new Map<number, number>();

    const count = (owner: number, key: string, delta: number): void => {
        const keys = byOwner.get(owner) ?? new Map<string, number>();
        const next = (keys.get(key) ?? 0) + delta;
        if (next > 0) keys.set(key, next);
        else keys.delete(key);
        if (keys.size > 0) byOwner.set(owner, keys);
        else byOwner.delete(owner);
    };
    const mirrorSet = (key: string, itemId: string, entry: MirrorEntry): MirrorEntry | undefined => {
        const items = mirror.get(key) ?? new Map<string, MirrorEntry>();
        mirror.set(key, items);
        const was = items.get(itemId);
        if (was) count(was.owner, key, -1);
        items.set(itemId, entry);
        count(entry.owner, key, 1);
        return was;
    };
    /** Vrai quand la ligne était bien à ce propriétaire : un élément passé chez un autre reste à lui. */
    const mirrorDelete = (key: string, itemId: string, owner: number): boolean => {
        const items = mirror.get(key);
        const was = items?.get(itemId);
        if (!items || !was || was.owner !== owner) return false;
        items.delete(itemId);
        count(owner, key, -1);
        return true;
    };

    const write = async (
        owner: number,
        source: StockSource,
        want: readonly SdkStockItem[]
    ): Promise<PlanPauseChange | null> => {
        const key = source.fullKey;
        // Le miroir suit la table : rien à écrire quand il dit déjà ce qu'on veut,
        // le cas de presque tous les comptes à chaque balayage.
        const held = [...(mirror.get(key) ?? [])].filter(([, entry]) => entry.owner === owner);
        if (
            held.length === want.length &&
            want.every((item) => held.some(([id, entry]) => id === item.id && entry.workspaceId === item.workspaceId))
        ) {
            return null;
        }
        const { removed, upserts } = await db.transaction(async (tx) => {
            const current = new Map((await tx.quotaPauses.ofOwnerKey(owner, key)).map((row) => [row.itemId, row]));
            const wanted = new Set(want.map((item) => item.id));
            const removed = [...current.values()].filter((row) => !wanted.has(row.itemId));
            // Neuf, ou déplacé d'un espace à l'autre du même compte.
            const upserts = want.filter((item) => current.get(item.id)?.workspaceId !== item.workspaceId);
            await tx.quotaPauses.remove(
                owner,
                key,
                removed.map((row) => row.itemId)
            );
            await tx.quotaPauses.upsert(
                upserts.map((item) => ({
                    quotaKey: key,
                    itemId: item.id,
                    ownerUserId: owner,
                    workspaceId: item.workspaceId
                }))
            );
            return { removed, upserts };
        });
        const resumed: SdkStockItem[] = [];
        for (const row of removed) {
            if (mirrorDelete(key, row.itemId, owner)) resumed.push({ id: row.itemId, workspaceId: row.workspaceId });
        }
        const paused: SdkStockItem[] = [];
        for (const item of upserts) {
            if (!mirrorSet(key, item.id, { owner, workspaceId: item.workspaceId })) paused.push(item);
        }
        return paused.length > 0 || resumed.length > 0 ? { key, featureId: source.featureId, paused, resumed } : null;
    };

    const noteChangesAt = (userId: number, at: number | undefined): void => {
        if (at === undefined || recheckKnown.get(userId) === at) return;
        recheckKnown.set(userId, at);
        db.quotaPauses
            .setRecheck(userId, at)
            .catch((err: unknown) => logger.error({ err, userId }, 'Échéance d’offre non enregistrée'));
    };

    const reconcile = async (owner: number): Promise<void> => {
        let plan: AccountPlan | null;
        try {
            plan = await host.planOf(owner);
        } catch (err) {
            // Surtout pas « illimité » ici : une panne de la facturation
            // relancerait tout, et la passe suivante remettrait tout en pause.
            logger.warn({ err, userId: owner }, 'Offre du compte illisible, pauses inchangées');
            return;
        }
        noteChangesAt(owner, plan?.changesAt);
        const owned = await db.workspaces.listOwnedIds(owner);
        const changes: PlanPauseChange[] = [];
        for (const source of host.sources()) {
            const limit = plan?.limits[source.fullKey] ?? null;
            let want: readonly SdkStockItem[] = [];
            if (limit !== null) {
                try {
                    want = await source.overLimit(owner, owned, limit);
                } catch (err) {
                    logger.error({ err, userId: owner, key: source.fullKey }, 'Stock illisible, pauses inchangées');
                    continue;
                }
            }
            const change = await write(owner, source, want);
            if (change) changes.push(change);
        }
        if (changes.length > 0) await host.applied(owner, changes);
    };

    // Une passe à la fois, pour tout le serveur : un geste (supprimer une sonde)
    // passe devant le balayage de fond.
    const urgent = new Set<number>();
    const background = new Set<number>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let working: Promise<void> | null = null;
    let running = false;
    const tickers: ReturnType<typeof setInterval>[] = [];

    const next = (): number | undefined => {
        for (const queue of [urgent, background]) {
            const first = queue.values().next();
            if (!first.done) {
                queue.delete(first.value);
                return first.value;
            }
        }
        return undefined;
    };
    const drain = async (): Promise<void> => {
        for (let owner = next(); owner !== undefined && running; owner = next()) {
            try {
                await reconcile(owner);
            } catch (err) {
                logger.error({ err, userId: owner }, 'Passe des pauses d’offre en échec');
            }
        }
    };
    const kick = (): void => {
        timer = null;
        if (working || !running) return;
        working = drain().finally(() => {
            working = null;
            if (running && (urgent.size > 0 || background.size > 0)) kick();
        });
    };
    const enqueue = (queue: Set<number>, owner: number): void => {
        if (queue === background && urgent.has(owner)) return;
        queue.add(owner);
        if (running && !timer && !working) timer = setTimeout(kick, DEBOUNCE_MS);
    };
    const every = (ms: number, fn: () => Promise<void>): void => {
        let busy = false;
        const handle = setInterval(() => {
            if (busy) return;
            busy = true;
            fn()
                .catch((err: unknown) => logger.error({ err }, 'Tâche des pauses d’offre en échec'))
                .finally(() => (busy = false));
        }, ms);
        handle.unref?.();
        tickers.push(handle);
    };

    return {
        async start() {
            const keys = host.sources().map((s) => s.fullKey);
            const purged = await db.quotaPauses.purgeKeysOtherThan(keys);
            if (purged > 0) logger.warn({ purged }, 'Pauses d’offre retirées : leur limite n’existe plus');
            for (const row of await db.quotaPauses.all()) {
                mirrorSet(row.quotaKey, row.itemId, { owner: row.ownerUserId, workspaceId: row.workspaceId });
            }
            running = true;
            // Tous les propriétaires, pas seulement ceux qui ont déjà des pauses :
            // une limite nouvelle ou abaissée arrive avec un déploiement.
            for (const owner of await db.workspaces.listOwnerIds()) enqueue(background, owner);
            every(RECHECK_EVERY_MS, async () => {
                for (const owner of await db.quotaPauses.takeDueRechecks(now())) {
                    recheckKnown.delete(owner);
                    enqueue(urgent, owner);
                }
            });
            every(SWEEP_EVERY_MS, async () => {
                for (const owner of await db.quotaPauses.owners()) enqueue(background, owner);
            });
            every(SWEEP_ALL_EVERY_MS, async () => {
                for (const owner of await db.workspaces.listOwnerIds()) enqueue(background, owner);
            });
            if (urgent.size > 0 || background.size > 0) timer = setTimeout(kick, DEBOUNCE_MS);
        },
        async stop() {
            running = false;
            if (timer) clearTimeout(timer);
            timer = null;
            for (const handle of tickers.splice(0)) clearInterval(handle);
            await working;
        },
        isPaused: (fullKey, itemId) => mirror.get(fullKey)?.has(itemId) ?? false,
        paused: (fullKey) => [...(mirror.get(fullKey)?.keys() ?? [])],
        countsOf: (owner) => Object.fromEntries(byOwner.get(owner) ?? []),
        hasPausesIn: (owner, featureId) =>
            [...(byOwner.get(owner)?.keys() ?? [])].some((key) => key.startsWith(`${featureId}.`)),
        schedule: (owner) => enqueue(urgent, owner),
        reconcile,
        noteChangesAt
    };
}

let INSTANCE: PlanPauses | null = null;

/** Posé une fois au boot. Sans lui (un test, un script), rien n'est en pause et rien ne se planifie. */
export function attachPlanPauses(instance: PlanPauses | null): void {
    INSTANCE = instance;
}

export function isPlanPaused(fullKey: string, itemId: string): boolean {
    return INSTANCE?.isPaused(fullKey, itemId) ?? false;
}

export function planPausedIds(fullKey: string): string[] {
    return INSTANCE?.paused(fullKey) ?? [];
}

export function planPauseCounts(ownerUserId: number): Record<string, number> {
    return INSTANCE?.countsOf(ownerUserId) ?? {};
}

export function schedulePlanReconcile(ownerUserId: number): void {
    INSTANCE?.schedule(ownerUserId);
}

/** Après un geste d'un module : une place a pu se libérer, si ce compte a quelque chose en pause chez lui. */
export function touchPlanPauses(ownerUserId: number, featureId: string): void {
    if (INSTANCE?.hasPausesIn(ownerUserId, featureId)) INSTANCE.schedule(ownerUserId);
}

export function notePlanChangesAt(userId: number, at: number | undefined): void {
    INSTANCE?.noteChangesAt(userId, at);
}

/** Un membre autre que le propriétaire perd l'accès à un espace partagé en pause, ou quand lui-même l'est. */
export function memberPausedIn(workspaceId: number, userId: number): boolean {
    return (
        isPlanPaused('workspace.shared', String(workspaceId)) ||
        isPlanPaused('workspace.members', `${workspaceId}:${userId}`)
    );
}

/** Ce que l'offre du propriétaire tient en pause dans un espace : l'espace lui-même, et ceux de ses membres. */
export function workspacePauses(
    workspaceId: number,
    memberIds: readonly number[]
): { planPaused: boolean; pausedMemberIds: number[] } {
    return {
        planPaused: isPlanPaused('workspace.shared', String(workspaceId)),
        pausedMemberIds: memberIds.filter((userId) => isPlanPaused('workspace.members', `${workspaceId}:${userId}`))
    };
}
