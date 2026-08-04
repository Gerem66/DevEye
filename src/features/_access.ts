import type { Database } from '@/db';

/**
 * Authorization resolution for feature commands.
 *
 * This is the single place that answers "what is this caller allowed to do?".
 * The WS dispatcher resolves an {@link AccessRecord} once per command and hands
 * the result to the handler through the feature context, so no handler ever
 * queries the role itself.
 */

/**
 * Bumped whenever something that grants or revokes access changes (today: an
 * account's global role). Every cached record carries the epoch it was built
 * under, so a mismatch forces a rebuild on the next command — a revocation takes
 * effect immediately, with no per-command database round-trip and no timer.
 */
let accessEpoch = 0;

/** Invalidate every cached access record, across all live connections. */
export function invalidateAccess(): void {
    accessEpoch += 1;
}

/**
 * Whether an account holds the global `admin` role — the single definition of
 * that question. The WS world reaches it through {@link createAccessResolver};
 * the fleet HTTP routes, which have no dispatcher to resolve access for them,
 * call it directly.
 */
export async function isAdminUser(db: Database, userId: number): Promise<boolean> {
    const user = await db.users.findById(userId);
    return user?.role === 'admin';
}

/** Everything the dispatcher needs to authorize a command. */
export interface AccessRecord {
    /**
     * Caller holds the global `admin` role — the gate for the device fleet and
     * the system pages (Logs). Deliberately *not* a key to other users' data.
     */
    isAdmin: boolean;
}

export interface AccessResolver {
    resolve(): Promise<AccessRecord>;
}

/**
 * Build the per-connection access resolver.
 *
 * Costs one query on the first command of a connection and nothing afterwards:
 * the record is reused until {@link invalidateAccess} bumps the epoch. Resolving
 * per command instead would put an extra `users` lookup in front of every hot
 * path (live metric polling, note listing…) to answer a question that changes
 * approximately never.
 */
export function createAccessResolver(db: Database, userId: number): AccessResolver {
    let cached: { epoch: number; record: Promise<AccessRecord> } | null = null;

    return {
        resolve(): Promise<AccessRecord> {
            if (cached && cached.epoch === accessEpoch) return cached.record;

            const epoch = accessEpoch;
            const record = (async (): Promise<AccessRecord> => ({
                isAdmin: await isAdminUser(db, userId)
            }))().catch((e: unknown) => {
                // Never cache a failure: a transient database error must not
                // leave the connection stuck believing it isn't an admin.
                if (cached?.epoch === epoch) cached = null;
                throw e;
            });

            cached = { epoch, record };
            return record;
        }
    };
}
