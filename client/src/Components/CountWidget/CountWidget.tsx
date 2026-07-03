import { useEffect, useMemo, useState } from 'react';

import { useAuth } from '@/auth/AuthProvider';
import { ws } from '@/api/ws';
import { useResourceVersion, type ResourceKey } from '@/stores/invalidation';
import styles from './CountWidget.module.css';

/** Commands that return a plain `{ count }` for a workspace. Each doubles as
 *  its own invalidation key (see `invalidate`), so the card refreshes when the
 *  matching data changes. Only the `.count`-shaped resources qualify. */
type CountCommand = Extract<ResourceKey, `${string}.count`>;

export type CountState = { kind: 'loading' } | { kind: 'ready'; count: number };

/**
 * Fetch a workspace item count over the WS, (re)fetching whenever the socket
 * opens. These commands are NOT gated by the password-encryption unlock, so the
 * result is a normal number even when the session is locked — no `locked` state,
 * no prompt. A transient send failure (socket not open yet, a drop) keeps the
 * last good value instead of collapsing into a misleading "0". It also
 * re-fetches when its resource is invalidated (e.g. a note/password created or
 * deleted), so the card stays in sync without a reload.
 */
export function useWorkspaceCount(command: CountCommand): CountState {
    const { user, workspaces } = useAuth();
    const workspace = useMemo(
        () => workspaces.find((w) => w.id === user?.defaultWorkspace) ?? workspaces[0] ?? null,
        [workspaces, user]
    );
    const version = useResourceVersion(command);
    const [state, setState] = useState<CountState>({ kind: 'loading' });

    useEffect(() => {
        if (!workspace) return;
        let cancelled = false;

        const load = () => {
            ws.send(command, { workspaceId: workspace.id })
                .then((res) => {
                    if (!cancelled) setState({ kind: 'ready', count: res.count });
                })
                .catch(() => {
                    if (!cancelled) setState((prev) => (prev.kind === 'ready' ? prev : { kind: 'loading' }));
                });
        };

        if (ws.state === 'open') load();
        const off = ws.onStateChange((s) => {
            if (s === 'open') load();
        });

        return () => {
            cancelled = true;
            off();
        };
        // `version` re-runs this effect when the resource is invalidated,
        // re-fetching the count (when the socket is open) after a mutation.
    }, [workspace, command, version]);

    return state;
}

interface CountWidgetProps {
    state: CountState;
    /** Singular noun, pluralized with a trailing "s" (e.g. "note" → "notes"). */
    noun: string;
    /** Secondary line shown under the count when there is at least one item. */
    hint: string;
    /** Secondary line shown when the count is zero. */
    empty: string;
}

/**
 * Compact dashboard card showing a single count (big number + noun) and a
 * secondary line. The layout is identical across loading/ready so nothing
 * shifts: the number sits top-left, the secondary line is pinned to the bottom.
 */
export function CountWidget({ state, noun, hint, empty }: CountWidgetProps) {
    const loading = state.kind === 'loading';
    const count = state.kind === 'ready' ? state.count : 0;
    const plural = loading || count !== 1;
    return (
        <div className={styles.widget}>
            <div className={styles.stat}>
                <span className={styles.value}>{loading ? '—' : count}</span>
                <span className={styles.label}>
                    {noun}
                    {plural ? 's' : ''}
                </span>
            </div>
            <span className={styles.foot}>{loading ? 'Chargement…' : count === 0 ? empty : hint}</span>
        </div>
    );
}

export default CountWidget;
