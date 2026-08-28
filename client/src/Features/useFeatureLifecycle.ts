import { useEffect, useRef } from 'react';
import type { FeatureLifecycle } from './types';

/**
 * Lifecycle hook every feature can use to hook into the cache system.
 *
 * The feature stays mounted while cached (see `cacheDurationMinutes` in the
 * Home widget registry). Whenever the cached instance is actually torn down —
 * TTL expiry, immediate close for `cacheDurationMinutes: 0`, a forced
 * Ctrl+click reset, or the dashboard unmounting — React unmounts the component
 * and the `onUnmount` callback fires exactly once. Use it to flush pending
 * edits, persist state, cancel subscriptions, etc.
 *
 * The callback is kept in a ref so features can pass an inline closure without
 * causing the cleanup to re-run on every render.
 *
 * @example
 * useFeatureLifecycle({
 *     onUnmount: () => {
 *         saveDraft();
 *         stopWatching(id);
 *     }
 * });
 */
export function useFeatureLifecycle({ onUnmount }: FeatureLifecycle): void {
    const onUnmountRef = useRef(onUnmount);
    onUnmountRef.current = onUnmount;

    useEffect(() => {
        return () => {
            onUnmountRef.current?.();
        };
    }, []);
}
