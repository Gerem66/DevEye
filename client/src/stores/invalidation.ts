import { useCallback, useSyncExternalStore } from 'react';

/**
 * Lightweight client-side cache-invalidation bus.
 *
 * Some views cache server-derived data locally and otherwise only re-fetch it
 * on a socket (re)open — e.g. the dashboard count widgets. When a feature
 * mutates that data (a note created, a password deleted) it calls
 * `invalidate(key)`, and every view reading that key via `useResourceVersion`
 * re-fetches. The dependency stays explicit and local to the mutation, with no
 * coupling to popup lifecycle nor to the consumers.
 *
 * Keys are listed explicitly (like the feature registries) so the set of
 * invalidatable resources stays visible and typo-proof. By convention a key is
 * the WS command whose result it caches.
 */
export type ResourceKey = 'note.count' | 'password.count';

const versions = new Map<ResourceKey, number>();
const listeners = new Map<ResourceKey, Set<() => void>>();

/** Bump one or more resources, re-fetching every view that reads them. */
export function invalidate(...keys: ResourceKey[]): void {
    for (const key of keys) {
        versions.set(key, (versions.get(key) ?? 0) + 1);
        listeners.get(key)?.forEach((fn) => fn());
    }
}

/**
 * A value that changes whenever `invalidate(key)` is called. Thread it through
 * a fetch effect's dependencies to re-run the fetch on invalidation.
 */
export function useResourceVersion(key: ResourceKey): number {
    const subscribe = useCallback(
        (notify: () => void) => {
            let set = listeners.get(key);
            if (!set) listeners.set(key, (set = new Set()));
            set.add(notify);
            return () => {
                set.delete(notify);
                if (set.size === 0) listeners.delete(key);
            };
        },
        [key]
    );
    return useSyncExternalStore(subscribe, () => versions.get(key) ?? 0);
}
