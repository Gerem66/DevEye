import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    FEEDBACK_PAGE_DEFAULT,
    type FeedbackEntry,
    type FeedbackFilter,
    type FeedbackKind,
    type FeedbackStatus
} from '@deveye/types';

import { ws, WsError } from '@/api/ws';
import Button from '@/Components/Button';
import { ConfirmDialog, type ConfirmRequest } from '@/Components/ConfirmDialog';
import SegmentedControl from '@/Components/SegmentedControl';
import StickyHeader from '@/Components/StickyHeader';
import TextInput from '@/Components/TextInput';
import { SnapshotView } from './SnapshotView';

import styles from './style.module.css';

/**
 * Page « Retours » : ce que les utilisateurs ont signalé, retours libres et
 * bugs mêlés, du plus récent au plus ancien.
 *
 * Réservée à l'administrateur global. L'entrée de menu est déjà masquée pour
 * les autres, mais chaque commande est gatée serveur : le masquage n'est qu'un
 * confort.
 */

/** L'état des filtres. `''` vaut « aucune contrainte ». */
interface FilterState {
    status: FeedbackStatus | '';
    kind: FeedbackKind | '';
    search: string;
}

const EMPTY_FILTER: FilterState = { status: '', kind: '', search: '' };

const STATUS_OPTIONS = [
    { value: '', label: 'Tous' },
    { value: 'new', label: 'Nouveaux' },
    { value: 'open', label: 'En cours' },
    { value: 'done', label: 'Traités' }
] as const;

const KIND_OPTIONS = [
    { value: '', label: 'Tous' },
    { value: 'general', label: 'Retours' },
    { value: 'bug', label: 'Bugs' }
] as const;

const STATUS_LABELS: Record<FeedbackStatus, string> = {
    new: 'Nouveau',
    open: 'En cours',
    done: 'Traité'
};

/** Le statut suivant proposé en un clic : le parcours normal d'un signalement. */
const NEXT_STATUS: Record<FeedbackStatus, FeedbackStatus> = {
    new: 'open',
    open: 'done',
    done: 'new'
};

const NEXT_LABELS: Record<FeedbackStatus, string> = {
    new: 'Prendre en charge',
    open: 'Marquer traité',
    done: 'Rouvrir'
};

/** Date et heure : un signalement se lit d'abord par son moment. */
function formatDate(unixSeconds: number): string {
    return new Date(unixSeconds * 1000).toLocaleString('fr-FR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

function authorLabel(entry: FeedbackEntry): string {
    return entry.username ?? `#${entry.uid}`;
}

/** Le filtre transmis : seuls les champs réellement posés. */
function buildFilter(f: FilterState): FeedbackFilter {
    const out: FeedbackFilter = {};
    if (f.status !== '') out.status = f.status;
    if (f.kind !== '') out.kind = f.kind;
    if (f.search.trim()) out.search = f.search.trim();
    return out;
}

export default function FeatureFeedback() {
    const [filter, setFilter] = useState<FilterState>(EMPTY_FILTER);
    const [entries, setEntries] = useState<FeedbackEntry[]>([]);
    const [total, setTotal] = useState(0);
    const [pending, setPending] = useState(0);
    const [hasMore, setHasMore] = useState(false);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [expanded, setExpanded] = useState<number | null>(null);
    const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

    // Identifie la requête en cours : une réponse périmée (jeton plus ancien)
    // est jetée à son arrivée, pour qu'un filtre changé vite ne coure jamais.
    const queryToken = useRef(0);

    const reload = useCallback(async (f: FilterState) => {
        const token = ++queryToken.current;
        setLoading(true);
        setError(null);
        try {
            const res = await ws.send('feedback.list', {
                ...buildFilter(f),
                limit: FEEDBACK_PAGE_DEFAULT,
                offset: 0
            });
            if (token !== queryToken.current) return;
            setEntries(res.entries);
            setTotal(res.total);
            setPending(res.pending);
            setHasMore(res.hasMore);
        } catch (e) {
            if (token !== queryToken.current) return;
            setEntries([]);
            setTotal(0);
            setHasMore(false);
            setError(
                e instanceof WsError && e.code === 'forbidden'
                    ? 'Accès réservé aux administrateurs.'
                    : 'Impossible de charger les retours.'
            );
        } finally {
            if (token === queryToken.current) setLoading(false);
        }
    }, []);

    const loadMore = useCallback(async () => {
        const token = queryToken.current;
        setLoading(true);
        try {
            const res = await ws.send('feedback.list', {
                ...buildFilter(filter),
                limit: FEEDBACK_PAGE_DEFAULT,
                offset: entries.length
            });
            if (token !== queryToken.current) return;
            setEntries((prev) => [...prev, ...res.entries]);
            setTotal(res.total);
            setPending(res.pending);
            setHasMore(res.hasMore);
        } catch {
            if (token === queryToken.current) setError('Impossible de charger plus de retours.');
        } finally {
            if (token === queryToken.current) setLoading(false);
        }
    }, [filter, entries.length]);

    // Relecture à chaque changement de filtre, retardée pour que la frappe dans
    // la recherche ne déclenche pas une requête par touche.
    useEffect(() => {
        const t = setTimeout(() => void reload(filter), 250);
        return () => clearTimeout(t);
    }, [filter, reload]);

    const set = useCallback(<K extends keyof FilterState>(key: K, value: FilterState[K]) => {
        setFilter((prev) => ({ ...prev, [key]: value }));
    }, []);

    const setStatus = useCallback(async (entry: FeedbackEntry, status: FeedbackStatus) => {
        setBusy(true);
        try {
            const res = await ws.send('feedback.setStatus', { id: entry.id, status });
            setEntries((prev) => prev.map((e) => (e.id === entry.id ? res.entry : e)));
            const before = entry.status === 'new' ? 1 : 0;
            const after = status === 'new' ? 1 : 0;
            setPending((prev) => Math.max(0, prev + after - before));
        } catch (e) {
            setError(e instanceof WsError ? e.message : 'Le statut n’a pas pu être changé.');
        } finally {
            setBusy(false);
        }
    }, []);

    const remove = useCallback(async (entry: FeedbackEntry) => {
        setBusy(true);
        try {
            await ws.send('feedback.delete', { id: entry.id });
            setEntries((prev) => prev.filter((e) => e.id !== entry.id));
            setTotal((prev) => Math.max(0, prev - 1));
            if (entry.status === 'new') setPending((prev) => Math.max(0, prev - 1));
        } catch (e) {
            setError(e instanceof WsError ? e.message : 'Le retour n’a pas pu être supprimé.');
        } finally {
            setBusy(false);
        }
    }, []);

    const filtered = useMemo(() => filter.status !== '' || filter.kind !== '' || filter.search.trim() !== '', [filter]);

    return (
        <div className={styles.container}>
            <StickyHeader className={styles.headerBand}>
                <header className={styles.header}>
                    <div className={styles.headerText}>
                        <h2 className={styles.title}>Retours</h2>
                        <p className={styles.subtitle}>
                            {total.toLocaleString('fr-FR')} signalement{total !== 1 ? 's' : ''}
                            {filtered ? ' (filtré)' : ''}
                            {pending > 0 && ` · ${pending} en attente`}
                        </p>
                    </div>
                    <div className={styles.headerActions}>
                        <Button icon='refresh' variant='secondary' onClick={() => void reload(filter)}>
                            Actualiser
                        </Button>
                        {filtered && (
                            <Button icon='x' variant='ghost' onClick={() => setFilter(EMPTY_FILTER)}>
                                Réinitialiser
                            </Button>
                        )}
                    </div>
                </header>
            </StickyHeader>

            <div className={styles.filters}>
                <SegmentedControl
                    options={STATUS_OPTIONS}
                    value={filter.status}
                    onChange={(v) => set('status', v)}
                    aria-label='Filtrer par statut'
                />
                <SegmentedControl
                    options={KIND_OPTIONS}
                    value={filter.kind}
                    onChange={(v) => set('kind', v)}
                    aria-label='Filtrer par nature'
                />
                <TextInput
                    className={styles.search}
                    placeholder='Rechercher dans les messages…'
                    value={filter.search}
                    onChange={(e) => set('search', e.target.value)}
                />
            </div>

            {error && <div className={styles.errorBanner}>{error}</div>}

            <div className={styles.list}>
                {entries.map((entry) => {
                    const isOpen = expanded === entry.id;
                    return (
                        <article key={entry.id} className={styles.card}>
                            <button
                                className={styles.cardHead}
                                onClick={() => setExpanded(isOpen ? null : entry.id)}
                                aria-expanded={isOpen}
                            >
                                <span className={`icon icon-${entry.kind === 'bug' ? 'bug' : 'info'}`} />
                                <span className={`${styles.status} ${styles[`status_${entry.status}`]}`}>
                                    {STATUS_LABELS[entry.status]}
                                </span>
                                <span className={styles.author}>{authorLabel(entry)}</span>
                                <span className={styles.date}>{formatDate(entry.created)}</span>
                                <span className={`${styles.excerpt} ${isOpen ? styles.excerptOpen : ''}`}>
                                    {entry.message}
                                </span>
                                <span className={`icon icon-chevron-down ${isOpen ? styles.chevronOpen : ''}`} />
                            </button>

                            {isOpen && (
                                <div className={styles.cardBody}>
                                    <p className={styles.message}>{entry.message}</p>

                                    {entry.snapshot ? (
                                        <SnapshotView snapshot={entry.snapshot} serverVersion={entry.appVersion} />
                                    ) : (
                                        <p className={styles.none}>
                                            {entry.kind === 'bug'
                                                ? 'Aucun rapport technique n’accompagne ce signalement.'
                                                : 'Un retour libre ne transporte pas de rapport technique.'}
                                        </p>
                                    )}

                                    <div className={styles.meta}>
                                        <span>DevEye {entry.appVersion}</span>
                                        <span>{entry.ip || 'IP inconnue'}</span>
                                        {entry.workspaceId !== null && <span>Espace #{entry.workspaceId}</span>}
                                        {entry.handledAt !== null && (
                                            <span>
                                                Traité le {formatDate(entry.handledAt)}
                                                {entry.handledByName && ` par ${entry.handledByName}`}
                                            </span>
                                        )}
                                    </div>

                                    <div className={styles.actions}>
                                        <Button
                                            variant='secondary'
                                            disabled={busy}
                                            onClick={() => void setStatus(entry, NEXT_STATUS[entry.status])}
                                        >
                                            {NEXT_LABELS[entry.status]}
                                        </Button>
                                        <Button
                                            variant='danger'
                                            icon='trash'
                                            disabled={busy}
                                            onClick={() =>
                                                setConfirm({
                                                    title: 'Supprimer ce retour ?',
                                                    description:
                                                        'Le message et son rapport technique seront effacés définitivement.',
                                                    onConfirm: () => void remove(entry)
                                                })
                                            }
                                        >
                                            Supprimer
                                        </Button>
                                    </div>
                                </div>
                            )}
                        </article>
                    );
                })}

                {!loading && entries.length === 0 && (
                    <div className={styles.empty}>
                        <span className={styles.emptyIcon}>📮</span>
                        <p>{filtered ? 'Aucun retour ne correspond aux filtres.' : 'Aucun retour pour le moment.'}</p>
                    </div>
                )}

                {loading && entries.length === 0 && (
                    <div className={styles.loadingRows}>
                        {Array.from({ length: 4 }).map((_, i) => (
                            <div key={i} className={styles.skeletonRow} />
                        ))}
                    </div>
                )}
            </div>

            <div className={styles.footer}>
                <span className={styles.footerInfo}>
                    {entries.length} / {total.toLocaleString('fr-FR')} affichés
                </span>
                {hasMore && (
                    <Button variant='secondary' disabled={loading} onClick={() => void loadMore()}>
                        {loading ? 'Chargement…' : 'Charger plus'}
                    </Button>
                )}
            </div>

            <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} busy={busy} />
        </div>
    );
}
