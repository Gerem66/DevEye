import { useEffect, useState } from 'react';

import { ws } from '@/api/ws';
import { useResourceVersion, type ResourceKey } from '@/stores/invalidation';
import styles from './CountWidget.module.css';
import { useActiveWorkspace } from '@/stores/workspace';

/** Commands that return a plain `{ count }` for a workspace. Each doubles as
 *  its own invalidation key (see `invalidate`). `uptime.count` et
 *  `sentinel.count` rendent une autre forme (`{ total, up, down }`, un décompte
 *  par gravité) et ont leur propre magasin : exclus. */
type CountCommand =
    | Exclude<Extract<ResourceKey, `${string}.count`>, 'uptime.count' | 'sentinel.count'>
    // Un module externe déclare sa propre clé `.count` dans son manifest ; le
    // registre des commandes la connaît au chargement, pas ce type.
    | `x-${string}.count`
    // Une commande de comptage au nom historique (`mail.accountCount`), même
    // forme de réponse.
    | `${string}.${string}Count`;

export type CountState = { kind: 'loading' } | { kind: 'ready'; count: number };

/**
 * Fetch a workspace item count over the WS, (re)fetching whenever the socket
 * opens or the resource is invalidated. Not gated by the password-encryption
 * unlock, so the result is a normal number even when locked. A transient send
 * failure keeps the last good value instead of collapsing into a misleading 0.
 */
export function useWorkspaceCount(command: CountCommand): CountState {
    const workspace = useActiveWorkspace();
    // Une commande au nom historique n'est pas une clé de ressource pour le
    // type, mais elle en est une pour le bus.
    const version = useResourceVersion(command as ResourceKey);
    const [state, setState] = useState<CountState>({ kind: 'loading' });

    useEffect(() => {
        if (!workspace) return;
        let cancelled = false;

        const load = () => {
            (ws.send(command as never, {} as never) as Promise<{ count: number }>)
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
    /** Pluriel explicite pour les mots que le « s » final n'accorde pas
     *  (« travail » → « travaux »). */
    plural?: string;
    /** Secondary line shown under the count when there is at least one item. */
    hint: string;
    /** Secondary line shown when the count is zero. */
    empty: string;
    /**
     * Teinte du nombre : `neutral` (défaut) est l'accent du thème, `danger` le
     * passe en rouge. Rare à dessein : une carte qui alerte n'est justifiée que
     * si l'ignorer coûte quelque chose (des sauvegardes qui échouent).
     */
    tone?: 'neutral' | 'danger';
}

/**
 * Compact dashboard card showing a single count (big number + noun) and a
 * secondary line. The layout is identical across loading/ready so nothing
 * shifts: the number sits top-left, the secondary line is pinned to the bottom.
 */
export function CountWidget({ state, noun, plural: pluralNoun, hint, empty, tone = 'neutral' }: CountWidgetProps) {
    const loading = state.kind === 'loading';
    const count = state.kind === 'ready' ? state.count : 0;
    const plural = loading || count !== 1;
    return (
        <div className={styles.widget}>
            <div className={styles.stat}>
                {/* Jamais de teinte pendant le chargement : un tiret rouge
                    annoncerait une panne là où il n'y a qu'une socket qui
                    s'ouvre. */}
                <span className={styles.value} data-tone={loading ? 'neutral' : tone}>
                    {loading ? '—' : count}
                </span>
                <span className={styles.label}>{plural ? (pluralNoun ?? `${noun}s`) : noun}</span>
            </div>
            <span className={styles.foot}>{loading ? 'Chargement…' : count === 0 ? empty : hint}</span>
        </div>
    );
}

export default CountWidget;
