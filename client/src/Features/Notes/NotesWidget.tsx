import { useEffect, useMemo, useState } from 'react';

import { useAuth } from '@/auth/AuthProvider';
import { ws, WsError } from '@/api/ws';
import type { NoteSummary } from 'deveye-types';
import styles from './NotesWidget.module.css';

type WidgetState = { kind: 'loading' } | { kind: 'locked' } | { kind: 'ready'; notes: NoteSummary[] };

/**
 * Compact dashboard card for Notes: a count of notes plus an at-a-glance
 * checklist progress (done / total checkboxes across all notes).
 *
 * Deliberately calls `note.list` *without* any unlock dance — locked notes come
 * back masked (no `checkTotal`/`checkDone` leak), so the widget never triggers a
 * password prompt just to render the dashboard.
 */
export function NotesWidget() {
    const { user, workspaces } = useAuth();
    const workspace = useMemo(
        () => workspaces.find((w) => w.id === user?.defaultWorkspace) ?? workspaces[0] ?? null,
        [workspaces, user]
    );
    const [state, setState] = useState<WidgetState>({ kind: 'loading' });

    useEffect(() => {
        if (!workspace) return;
        let cancelled = false;

        const load = () => {
            ws.send('note.list', { workspaceId: workspace.id })
                .then((res) => {
                    if (!cancelled) setState({ kind: 'ready', notes: res.notes });
                })
                .catch((e) => {
                    if (cancelled) return;
                    // Password encryption on + session locked: don't pop an unlock
                    // prompt from a dashboard card — just say so.
                    if (e instanceof WsError && (e.code === 'locked' || e.code === 'auth_required')) {
                        setState({ kind: 'locked' });
                    } else {
                        // A transient connection error (WS not open yet at mount, or
                        // a drop) must NOT collapse into a permanent "0 notes": stay
                        // in loading and let the reconnect below re-fetch.
                        setState((prev) => (prev.kind === 'ready' ? prev : { kind: 'loading' }));
                    }
                });
        };

        // Fetch now if the socket is already open; otherwise wait for it. Also
        // re-fetch whenever the connection (re)opens, so the count is never left
        // stale from a send that raced the WS handshake at startup.
        if (ws.state === 'open') load();
        const off = ws.onStateChange((s) => {
            if (s === 'open') load();
        });

        return () => {
            cancelled = true;
            off();
        };
    }, [workspace]);

    if (state.kind === 'loading') {
        return (
            <div className={styles.widgetContent}>
                <span className={styles.empty}>Chargement…</span>
            </div>
        );
    }

    if (state.kind === 'locked') {
        return (
            <div className={styles.widgetContent}>
                <span className={styles.empty}>Déverrouillez pour voir vos notes</span>
            </div>
        );
    }

    const notes = state.notes;
    const count = notes.length;
    const checkTotal = notes.reduce((sum, n) => sum + n.checkTotal, 0);
    const checkDone = notes.reduce((sum, n) => sum + n.checkDone, 0);

    return (
        <div className={styles.widgetContent}>
            <div className={styles.stat}>
                <span className={styles.statValue}>{count}</span>
                <span className={styles.statLabel}>note{count !== 1 ? 's' : ''}</span>
            </div>
            {count === 0 ? (
                <span className={styles.empty}>Aucune note</span>
            ) : checkTotal > 0 ? (
                <span className={styles.footnote}>
                    {checkDone}/{checkTotal} case{checkTotal !== 1 ? 's' : ''} cochée{checkDone !== 1 ? 's' : ''}
                </span>
            ) : (
                <span className={styles.hint}>Vos notes et pense-bêtes</span>
            )}
        </div>
    );
}

export default NotesWidget;
