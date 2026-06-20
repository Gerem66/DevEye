import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
    LOGS_PAGE_DEFAULT,
    LOG_LEVEL_NAMES,
    logLevelName,
    logLevelValue,
    type LogEntry,
    type LogFilter,
    type LogLevelName,
    type LogSource
} from 'deveye-types';

import { ws, WsError } from '@/api/ws';
import Button from '@/Components/Button';
import TextInput from '@/Components/TextInput';
import SelectInput from '@/Components/SelectInput';

import styles from './style.module.css';

/** Facet shapes returned by `logs.facets` (kept local to avoid extra exports). */
interface Facets {
    users: { uid: number; username: string | null; count: number }[];
    categories: { value: string; count: number }[];
    sources: { value: string; count: number }[];
    actions: { value: string; count: number }[];
    total: number;
}

/** The full editable filter state. Empty string / null means "no constraint". */
interface FilterState {
    search: string;
    uid: string; // select value (stringified id) or ''
    source: string;
    category: string;
    action: string;
    levelMin: LogLevelName | '';
    ip: string;
    dateFrom: string; // datetime-local value
    dateTo: string;
}

const EMPTY_FILTER: FilterState = {
    search: '',
    uid: '',
    source: '',
    category: '',
    action: '',
    levelMin: '',
    ip: '',
    dateFrom: '',
    dateTo: ''
};

const SOURCE_LABELS: Record<LogSource, string> = {
    web: 'Web',
    api: 'API',
    agent: 'Agent',
    system: 'Système'
};

const LEVEL_LABELS: Record<LogLevelName, string> = {
    debug: 'Debug',
    info: 'Info',
    warning: 'Avertissement',
    error: 'Erreur',
    critical: 'Critique'
};

/** A user id of 0 is the system / unauthenticated actor. */
function userLabel(uid: number, username: string | null): string {
    if (uid === 0) return 'Système';
    return username ?? `#${uid}`;
}

/** Full date + time down to the second — "voir précisément les horaires". */
function formatDate(unixSeconds: number): string {
    return new Date(unixSeconds * 1000).toLocaleString('fr-FR', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
}

/** datetime-local string → unix seconds, or undefined when empty/invalid. */
function toUnixSeconds(local: string): number | undefined {
    if (!local) return undefined;
    const ms = new Date(local).getTime();
    return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000);
}

/** Build the wire filter (only set fields) from the UI state. */
function buildFilter(f: FilterState): LogFilter {
    const out: LogFilter = {};
    if (f.search.trim()) out.search = f.search.trim();
    if (f.uid !== '') out.uid = Number(f.uid);
    if (f.source) out.source = f.source as LogSource;
    if (f.category) out.category = f.category;
    if (f.action) out.action = f.action;
    if (f.levelMin) out.levelMin = logLevelValue(f.levelMin);
    if (f.ip.trim()) out.ip = f.ip.trim();
    const from = toUnixSeconds(f.dateFrom);
    if (from !== undefined) out.dateFrom = from;
    const to = toUnixSeconds(f.dateTo);
    if (to !== undefined) out.dateTo = to;
    return out;
}

function FeatureLogs() {
    const [filter, setFilter] = useState<FilterState>(EMPTY_FILTER);
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const [total, setTotal] = useState(0);
    const [hasMore, setHasMore] = useState(false);
    const [facets, setFacets] = useState<Facets | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [expanded, setExpanded] = useState<number | null>(null);

    // Identifies the active query; a stale in-flight load (older token) is
    // discarded when its response arrives so fast filter changes never race.
    const queryToken = useRef(0);

    const loadFacets = useCallback(async () => {
        try {
            const res = await ws.send('logs.facets', {});
            setFacets(res);
        } catch {
            // Non-fatal: the table still works, the dropdowns just stay sparse.
        }
    }, []);

    /** Load page 0 for the current filter (replaces the list). */
    const reload = useCallback(async (f: FilterState) => {
        const token = ++queryToken.current;
        setLoading(true);
        setError(null);
        try {
            const res = await ws.send('logs.list', { ...buildFilter(f), limit: LOGS_PAGE_DEFAULT, offset: 0 });
            if (token !== queryToken.current) return;
            setLogs(res.logs);
            setTotal(res.total);
            setHasMore(res.hasMore);
        } catch (e) {
            if (token !== queryToken.current) return;
            setLogs([]);
            setTotal(0);
            setHasMore(false);
            setError(
                e instanceof WsError && e.code === 'forbidden'
                    ? 'Accès réservé aux administrateurs.'
                    : 'Impossible de charger les logs.'
            );
        } finally {
            if (token === queryToken.current) setLoading(false);
        }
    }, []);

    /** Append the next page for the current filter. */
    const loadMore = useCallback(async () => {
        const token = queryToken.current;
        setLoading(true);
        try {
            const res = await ws.send('logs.list', {
                ...buildFilter(filter),
                limit: LOGS_PAGE_DEFAULT,
                offset: logs.length
            });
            if (token !== queryToken.current) return;
            setLogs((prev) => [...prev, ...res.logs]);
            setTotal(res.total);
            setHasMore(res.hasMore);
        } catch {
            if (token === queryToken.current) setError('Impossible de charger plus de logs.');
        } finally {
            if (token === queryToken.current) setLoading(false);
        }
    }, [filter, logs.length]);

    // Initial load.
    useEffect(() => {
        void loadFacets();
    }, [loadFacets]);

    // Reload whenever a filter changes, debounced so typing in the text/IP
    // fields doesn't fire a query per keystroke.
    useEffect(() => {
        const t = setTimeout(() => void reload(filter), 250);
        return () => clearTimeout(t);
    }, [filter, reload]);

    const set = useCallback(<K extends keyof FilterState>(key: K, value: FilterState[K]) => {
        setFilter((prev) => ({ ...prev, [key]: value }));
    }, []);

    const resetFilters = useCallback(() => setFilter(EMPTY_FILTER), []);

    const activeCount = useMemo(() => Object.entries(filter).filter(([, v]) => v !== '').length, [filter]);

    return (
        <div className={styles.container}>
            <header className={styles.header}>
                <div className={styles.headerText}>
                    <h2 className={styles.title}>Logs</h2>
                    <p className={styles.subtitle}>
                        {total.toLocaleString('fr-FR')} entrée{total !== 1 ? 's' : ''}
                        {activeCount > 0 ? ' (filtré)' : ''}
                    </p>
                </div>
                <div className={styles.headerActions}>
                    <Button
                        icon='refresh'
                        variant='secondary'
                        onClick={() => {
                            void loadFacets();
                            void reload(filter);
                        }}
                    >
                        Actualiser
                    </Button>
                    {activeCount > 0 && (
                        <Button icon='x' variant='ghost' onClick={resetFilters}>
                            Réinitialiser
                        </Button>
                    )}
                </div>
            </header>

            <div className={styles.filters}>
                <div className={`${styles.filterField} ${styles.searchField}`}>
                    <label className={styles.filterLabel}>Recherche</label>
                    <TextInput
                        placeholder='Description, action, IP…'
                        value={filter.search}
                        onChange={(e) => set('search', e.target.value)}
                    />
                </div>

                <div className={styles.filterField}>
                    <label className={styles.filterLabel}>Utilisateur</label>
                    <SelectInput value={filter.uid} onChange={(e) => set('uid', e.target.value)}>
                        <option value=''>Tous</option>
                        {facets?.users.map((u) => (
                            <option key={u.uid} value={String(u.uid)}>
                                {userLabel(u.uid, u.username)} ({u.count})
                            </option>
                        ))}
                    </SelectInput>
                </div>

                <div className={styles.filterField}>
                    <label className={styles.filterLabel}>Canal</label>
                    <SelectInput value={filter.source} onChange={(e) => set('source', e.target.value)}>
                        <option value=''>Tous</option>
                        {facets?.sources.map((s) => (
                            <option key={s.value} value={s.value}>
                                {SOURCE_LABELS[s.value as LogSource] ?? s.value} ({s.count})
                            </option>
                        ))}
                    </SelectInput>
                </div>

                <div className={styles.filterField}>
                    <label className={styles.filterLabel}>Fonctionnalité</label>
                    <SelectInput value={filter.category} onChange={(e) => set('category', e.target.value)}>
                        <option value=''>Toutes</option>
                        {facets?.categories.map((c) => (
                            <option key={c.value} value={c.value}>
                                {c.value} ({c.count})
                            </option>
                        ))}
                    </SelectInput>
                </div>

                <div className={styles.filterField}>
                    <label className={styles.filterLabel}>Action</label>
                    <SelectInput value={filter.action} onChange={(e) => set('action', e.target.value)}>
                        <option value=''>Toutes</option>
                        {facets?.actions.map((a) => (
                            <option key={a.value} value={a.value}>
                                {a.value} ({a.count})
                            </option>
                        ))}
                    </SelectInput>
                </div>

                <div className={styles.filterField}>
                    <label className={styles.filterLabel}>Importance min.</label>
                    <SelectInput
                        value={filter.levelMin}
                        onChange={(e) => set('levelMin', e.target.value as LogLevelName | '')}
                    >
                        <option value=''>Toutes</option>
                        {LOG_LEVEL_NAMES.map((lvl) => (
                            <option key={lvl} value={lvl}>
                                {LEVEL_LABELS[lvl]}
                            </option>
                        ))}
                    </SelectInput>
                </div>

                <div className={styles.filterField}>
                    <label className={styles.filterLabel}>IP</label>
                    <TextInput placeholder='Adresse IP' value={filter.ip} onChange={(e) => set('ip', e.target.value)} />
                </div>

                <div className={styles.filterField}>
                    <label className={styles.filterLabel}>Du</label>
                    <input
                        type='datetime-local'
                        className={styles.dateInput}
                        value={filter.dateFrom}
                        onChange={(e) => set('dateFrom', e.target.value)}
                    />
                </div>

                <div className={styles.filterField}>
                    <label className={styles.filterLabel}>Au</label>
                    <input
                        type='datetime-local'
                        className={styles.dateInput}
                        value={filter.dateTo}
                        onChange={(e) => set('dateTo', e.target.value)}
                    />
                </div>
            </div>

            {error && <div className={styles.errorBanner}>{error}</div>}

            <div className={styles.tableWrap}>
                <table className={styles.table}>
                    <thead>
                        <tr>
                            <th>Date</th>
                            <th>Niveau</th>
                            <th>Canal</th>
                            <th>Fonctionnalité</th>
                            <th>Action</th>
                            <th>Utilisateur</th>
                            <th>IP</th>
                            <th>Description</th>
                        </tr>
                    </thead>
                    <tbody>
                        {logs.map((log) => {
                            const lvl = logLevelName(log.level);
                            const hasMeta = log.metadata && Object.keys(log.metadata).length > 0;
                            const isOpen = expanded === log.id;
                            return (
                                <Fragment key={log.id}>
                                    <tr
                                        className={`${styles.row} ${hasMeta ? styles.clickable : ''}`}
                                        onClick={() => hasMeta && setExpanded(isOpen ? null : log.id)}
                                    >
                                        <td className={styles.dateCell}>{formatDate(log.date)}</td>
                                        <td>
                                            <span className={`${styles.level} ${styles[`level_${lvl}`]}`}>
                                                {LEVEL_LABELS[lvl]}
                                            </span>
                                        </td>
                                        <td>
                                            <span className={styles.sourceTag}>
                                                {SOURCE_LABELS[log.source] ?? log.source}
                                            </span>
                                        </td>
                                        <td className={styles.mono}>{log.category || '—'}</td>
                                        <td className={styles.mono}>{log.action || '—'}</td>
                                        <td>{userLabel(log.uid, log.username)}</td>
                                        <td className={styles.mono}>{log.ip || '—'}</td>
                                        <td className={styles.descCell}>
                                            {log.description}
                                            {hasMeta && <span className={styles.metaHint}>{isOpen ? ' ▾' : ' ▸'}</span>}
                                        </td>
                                    </tr>
                                    {isOpen && hasMeta && (
                                        <tr className={styles.metaRow}>
                                            <td colSpan={8}>
                                                <pre className={styles.metaPre}>
                                                    {JSON.stringify(log.metadata, null, 2)}
                                                </pre>
                                            </td>
                                        </tr>
                                    )}
                                </Fragment>
                            );
                        })}
                    </tbody>
                </table>

                {!loading && logs.length === 0 && (
                    <div className={styles.empty}>
                        <span className={styles.emptyIcon}>🗒️</span>
                        <p>{activeCount > 0 ? 'Aucun log ne correspond aux filtres.' : 'Aucun log pour le moment.'}</p>
                    </div>
                )}

                {loading && logs.length === 0 && (
                    <div className={styles.loadingRows}>
                        {Array.from({ length: 8 }).map((_, i) => (
                            <div key={i} className={styles.skeletonRow} />
                        ))}
                    </div>
                )}
            </div>

            <div className={styles.footer}>
                <span className={styles.footerInfo}>
                    {logs.length} / {total.toLocaleString('fr-FR')} affichés
                </span>
                {hasMore && (
                    <Button variant='secondary' disabled={loading} onClick={() => void loadMore()}>
                        {loading ? 'Chargement…' : 'Charger plus'}
                    </Button>
                )}
            </div>
        </div>
    );
}

export default FeatureLogs;
