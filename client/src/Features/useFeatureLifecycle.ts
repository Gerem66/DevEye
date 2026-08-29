import { useEffect, useRef } from 'react';
import type { FeatureLifecycle } from './types';

/**
 * Hook into the feature cache: `onUnmount` fires exactly once when the cached
 * instance is torn down, whatever the reason (see `cacheDurationMinutes` in the
 * Home widget registry). Use it to flush pending edits, persist state or cancel
 * subscriptions.
 *
 * The callback is kept in a ref so features can pass an inline closure without
 * making the cleanup re-run on every render.
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
