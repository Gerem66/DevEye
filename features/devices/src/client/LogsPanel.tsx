import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
    acquireMetrics,
    Button,
    CopyButton,
    LoadingVeil,
    onServerEvent,
    SearchSelect,
    TextInput,
    type SearchSelectFilter,
    type SearchSelectOption
} from 'deveye-sdk-client';
import {
    DEVICE_LOG_LEVELS,
    DEVICE_LOG_LINES_EVENT,
    DEVICE_LOG_PAGE_DEFAULT,
    DEVICE_LOG_SOURCES_EVENT,
    deviceLogLinesPushSchema,
    deviceLogSourcesPushSchema,
    type DeviceLogAnchor,
    type DeviceLogFilter,
    type DeviceLogLevel,
    type DeviceLogLine,
    type DeviceLogSource,
    type DeviceLogSourceKind
} from '@deveye/types';

import { agent } from './api';
import styles from './style.module.css';

/**
 * Plafond du tampon d'un flux de journaux : le tampon n'est vidé que par la
 * trame `done`, qu'un agent disparu en plein flux n'envoie jamais.
 */
const MAX_BUFFERED_LINES = 20_000;

/**
 * Plafond de ce qu'on empile en remontant l'historique. La liste n'est pas
 * virtualisée : au-delà, la fenêtre devient poisseuse à faire défiler.
 */
const MAX_LOADED_LINES = 10_000;

const LEVEL_LABELS: Record<DeviceLogLevel, string> = {
    debug: 'Debug',
    info: 'Info',
    notice: 'Notice',
    warning: 'Avertissement',
    error: 'Erreur',
    critical: 'Critique'
};

const LEVEL_CLASS: Record<DeviceLogLevel, string> = {
    debug: styles.logLvlDebug,
    info: styles.logLvlInfo,
    notice: styles.logLvlNotice,
    warning: styles.logLvlWarning,
    error: styles.logLvlError,
    critical: styles.logLvlCritical
};

/** Teinte de toute la rangée, pour ce qui mérite l'œil. */
const LINE_TONE: Partial<Record<DeviceLogLevel, string>> = {
    warning: styles.logLineWarning,
    error: styles.logLineError,
    critical: styles.logLineError
};

const LEVEL_OPTIONS: readonly SearchSelectOption<DeviceLogLevel | ''>[] = [
    { value: '', label: 'Tous niveaux' },
    ...DEVICE_LOG_LEVELS.map((level) => ({ value: level, label: `≥ ${LEVEL_LABELS[level]}` }))
];

/** Group label for the source list, by source kind. */
const KIND_GROUP: Record<DeviceLogSourceKind, string> = {
    journald: 'Système',
    oslog: 'Système',
    eventlog: 'Système',
    syslog: 'Fichiers',
    docker: 'Conteneurs'
};

const CONTAINER_GROUP = KIND_GROUP.docker;

/** Mot-clé d'un conteneur qui tourne : la pastille « En cours » et la recherche le lisent. */
const RUNNING_KEYWORDS = ['running', 'en cours'];

/** Les pastilles du sélecteur de source ; celles d'un type absent ne s'affichent pas. */
const SOURCE_FILTERS: readonly SearchSelectFilter[] = [
    { value: 'system', label: 'Système', exclusive: 'kind', test: (o) => o.group === KIND_GROUP.journald },
    { value: 'containers', label: 'Conteneurs', exclusive: 'kind', test: (o) => o.group === CONTAINER_GROUP },
    { value: 'files', label: 'Fichiers', exclusive: 'kind', test: (o) => o.group === KIND_GROUP.syslog },
    { value: 'running', label: 'En cours', test: (o) => o.keywords?.includes(RUNNING_KEYWORDS[0]) ?? false }
];

/**
 * Quand aucun conteneur n'est listé : l'agent ne peut pas distinguer « pas de
 * moteur » de « socket refusée », la note dit donc la condition.
 */
const NO_CONTAINERS_HINT =
    'Aucun conteneur listé. L’agent les énumère avec « docker ps » / « podman ps » : il lui faut ' +
    'donc accès au démon : service installé en root, ou son utilisateur dans le groupe « docker ».';

const TIME_PRESETS: { label: string; seconds: number | null }[] = [
    { label: 'Tout', seconds: null },
    { label: '15 min', seconds: 15 * 60 },
    { label: '1 h', seconds: 60 * 60 },
    { label: '6 h', seconds: 6 * 60 * 60 },
    { label: '24 h', seconds: 24 * 60 * 60 }
];

const LIVE_INTERVAL_MS = 3000;

/**
 * Délai au-delà duquel on cesse d'attendre une interrogation. Filet de sécurité :
 * l'agent abandonne lui-même au bout de 45 s avec une erreur, celui-ci ne sert
 * qu'à un agent disparu en plein vol.
 */
const QUERY_TIMEOUT_MS = 60_000;

/** Au-delà, l'inventaire est réputé perdu : l'agent répond d'ordinaire en quelques secondes. */
const SOURCES_TIMEOUT_MS = 20_000;

/**
 * `replace` repart de l'extrémité choisie, `more` réclame la page suivante dans la
 * direction que dicte l'ancre : plus ancien depuis `newest`, plus récent depuis
 * `oldest`.
 */
type LoadMode = 'replace' | 'more';

/** Ce que le rendu suivant doit faire du défilement, décidé à la fusion. */
type ScrollAction = 'bottom' | 'top' | 'keep' | null;

/** Une ligne et sa clé de rendu, stable même quand une page s'insère en tête. */
type KeyedLine = { key: number; line: DeviceLogLine };

const formatTs = (ts: number | null): string => (ts ? new Date(ts).toLocaleString('fr-FR', { hour12: false }) : '·');

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Les occurrences de la recherche dans un texte, surlignées. */
function highlight(text: string, re: RegExp | null): ReactNode {
    if (!re) return text;
    const parts: ReactNode[] = [];
    let from = 0;
    for (const match of text.matchAll(re)) {
        if (match[0] === '') continue;
        const at = match.index;
        if (at > from) parts.push(text.slice(from, at));
        parts.push(
            <mark key={at} className={styles.logMark}>
                {match[0]}
            </mark>
        );
        from = at + match[0].length;
    }
    if (parts.length === 0) return text;
    if (from < text.length) parts.push(text.slice(from));
    return parts;
}

/**
 * Log viewer for one device: its log sources (system journal, one entry per
 * container, files), filtered queries against the selected one, a live mode.
 * Everything streams over the device's push channel, so the panel acquires the
 * shared live subscription.
 */
export function LogsPanel({ deviceId }: { deviceId: string }) {
    const [sources, setSources] = useState<DeviceLogSource[] | null>(null);
    const [sourcesLoading, setSourcesLoading] = useState(false);
    const [sourcesTimedOut, setSourcesTimedOut] = useState(false);
    const [sourceId, setSourceId] = useState('');
    const [search, setSearch] = useState('');
    const [regex, setRegex] = useState(false);
    const [levelMin, setLevelMin] = useState<DeviceLogLevel | ''>('');
    const [unit, setUnit] = useState('');
    const [sinceSec, setSinceSec] = useState<number | null>(null);
    const [anchor, setAnchor] = useState<DeviceLogAnchor>('newest');
    const [lines, setLines] = useState<KeyedLine[]>([]);
    const [hasMore, setHasMore] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [live, setLive] = useState(false);

    /**
     * L'interrogation en vol : le routeur ne retient que ses trames. `silent`
     * pour un tic du mode direct, qui ne doit pas voiler la liste toutes les 3 s.
     */
    const pendingRef = useRef<{ queryId: string; mode: LoadMode; anchor: DeviceLogAnchor; silent: boolean }>({
        queryId: '',
        mode: 'replace',
        anchor: 'newest',
        silent: false
    });
    const bufferRef = useRef<DeviceLogLine[]>([]);
    const scrollRef = useRef<HTMLDivElement>(null);
    const sentinelRef = useRef<HTMLDivElement>(null);
    /** Lu par le minuteur du mode direct, qui ne doit pas dépendre du rendu. */
    const loadingRef = useRef(false);
    loadingRef.current = loading;
    /** Lignes déjà empilées, en ref : l'offset ne doit pas refabriquer `runQuery`. */
    const linesRef = useRef<KeyedLine[]>([]);
    const nextKeyRef = useRef(0);
    const scrollActionRef = useRef<ScrollAction>(null);
    /** Distance au bas du contenu, relevée avant une insertion en tête. */
    const bottomGapRef = useRef(0);
    const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const sourcesWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const clearWatchdog = useCallback(() => {
        if (watchdogRef.current !== null) {
            clearTimeout(watchdogRef.current);
            watchdogRef.current = null;
        }
    }, []);
    const clearSourcesWatchdog = useCallback(() => {
        if (sourcesWatchdogRef.current !== null) {
            clearTimeout(sourcesWatchdogRef.current);
            sourcesWatchdogRef.current = null;
        }
    }, []);

    // Les chiens de garde survivraient au démontage du panneau.
    useEffect(() => clearWatchdog, [clearWatchdog]);
    useEffect(() => clearSourcesWatchdog, [clearSourcesWatchdog]);

    useEffect(() => acquireMetrics(deviceId), [deviceId]);

    const selectedSource = useMemo(() => sources?.find((s) => s.id === sourceId) ?? null, [sources, sourceId]);

    // Reset when the device changes; the effect below re-fetches its sources.
    useEffect(() => {
        setSources(null);
        setSourcesTimedOut(false);
        setSourceId('');
        setLines([]);
        setAnchor('newest');
        setHasMore(false);
        setError(null);
        linesRef.current = [];
    }, [deviceId]);

    /** (Re)demande l'inventaire des sources : les conteneurs vont et viennent. */
    const requestSources = useCallback(() => {
        setSourcesLoading(true);
        setSourcesTimedOut(false);
        clearSourcesWatchdog();
        // Sans réponse, le panneau dirait « détection… » pour toujours.
        sourcesWatchdogRef.current = setTimeout(() => {
            setSourcesLoading(false);
            setSourcesTimedOut(true);
        }, SOURCES_TIMEOUT_MS);
        void agent.send('agent.logSources', { deviceId }).catch(() => {
            clearSourcesWatchdog();
            setSources([]);
            setSourcesLoading(false);
        });
    }, [deviceId, clearSourcesWatchdog]);

    // Subscribe to the source/line pushes and ask for the source inventory.
    useEffect(() => {
        const offSources = onServerEvent(DEVICE_LOG_SOURCES_EVENT, deviceLogSourcesPushSchema, (d) => {
            if (d.deviceId !== deviceId) return;
            clearSourcesWatchdog();
            setSources(d.sources);
            setSourcesLoading(false);
            setSourcesTimedOut(false);
            // Une source disparue entre deux inventaires ne doit pas rester
            // sélectionnée : la requête suivante échouerait.
            setSourceId((cur) => (d.sources.some((s) => s.id === cur) ? cur : (d.sources[0]?.id ?? '')));
        });
        const offLines = onServerEvent(DEVICE_LOG_LINES_EVENT, deviceLogLinesPushSchema, (d) => {
            const pending = pendingRef.current;
            if (d.deviceId !== deviceId || d.queryId !== pending.queryId) return;
            // Borné : sans `done` (un agent mort en plein flux), le tampon
            // grossirait à chaque interrogation du mode direct. On garde la queue.
            const merged = bufferRef.current.concat(d.lines);
            bufferRef.current = merged.length > MAX_BUFFERED_LINES ? merged.slice(-MAX_BUFFERED_LINES) : merged;
            if (!d.done) return;

            clearWatchdog();
            setLoading(false);
            setError(d.error ?? null);
            if (d.error) {
                // Ne pas relancer la sentinelle en rafale sur une source en erreur.
                setHasMore(false);
                return;
            }

            const page = bufferRef.current;
            const prepend = pending.mode === 'more' && pending.anchor === 'newest';
            if (prepend) {
                const el = scrollRef.current;
                bottomGapRef.current = el ? el.scrollHeight - el.scrollTop : 0;
            }
            scrollActionRef.current =
                pending.mode === 'replace' ? (pending.anchor === 'newest' ? 'bottom' : 'top') : prepend ? 'keep' : null;

            const keyed = page.map((line) => ({ key: nextKeyRef.current++, line }));
            const prev = linesRef.current;
            const next = pending.mode === 'replace' ? keyed : prepend ? [...keyed, ...prev] : [...prev, ...keyed];
            linesRef.current = next;
            setLines(next);
            setHasMore(page.length >= DEVICE_LOG_PAGE_DEFAULT && next.length < MAX_LOADED_LINES);
        });
        requestSources();
        return () => {
            offSources();
            offLines();
        };
    }, [deviceId, requestSources, clearWatchdog, clearSourcesWatchdog]);

    const runQuery = useCallback(
        (mode: LoadMode, silent = false) => {
            if (!sourceId) return;
            const queryId = crypto.randomUUID();
            pendingRef.current = { queryId, mode, anchor, silent };
            bufferRef.current = [];
            setLoading(true);
            setError(null);
            clearWatchdog();
            watchdogRef.current = setTimeout(() => {
                // Une interrogation plus récente est passée devant, avec son propre
                // chien de garde.
                if (pendingRef.current.queryId !== queryId) return;
                setLoading(false);
                setHasMore(false);
                setError("L'appareil n'a pas répondu. Resserrez la fenêtre de temps ou le filtre, puis réessayez.");
            }, QUERY_TIMEOUT_MS);
            const filter: DeviceLogFilter = {};
            if (search.trim()) {
                filter.search = search.trim();
                if (regex) filter.regex = true;
            }
            if (levelMin) filter.levelMin = levelMin;
            if (unit.trim() && selectedSource?.kind === 'journald') filter.unit = unit.trim();
            if (sinceSec) filter.since = Math.floor(Date.now() / 1000) - sinceSec;
            agent
                .send('agent.logQuery', {
                    deviceId,
                    sourceId,
                    queryId,
                    filter: Object.keys(filter).length ? filter : undefined,
                    limit: DEVICE_LOG_PAGE_DEFAULT,
                    offset: mode === 'replace' ? 0 : linesRef.current.length,
                    anchor
                })
                .catch((e) => {
                    clearWatchdog();
                    setLoading(false);
                    setHasMore(false);
                    setError(e instanceof Error ? e.message : 'Échec de la requête');
                });
        },
        [deviceId, sourceId, search, regex, levelMin, unit, sinceSec, anchor, selectedSource, clearWatchdog]
    );

    // Debounced auto-run on any filter/source/anchor change.
    useEffect(() => {
        if (!sourceId) return;
        const t = setTimeout(() => runQuery('replace'), 300);
        return () => clearTimeout(t);
    }, [runQuery, sourceId]);

    /**
     * Remonter (ou descendre) dans l'historique et le mode direct s'excluent :
     * celui-ci réinterroge toutes les 3 s et écraserait la lecture en cours.
     */
    const loadMore = useCallback(() => {
        if (loadingRef.current || !hasMore) return;
        setLive(false);
        runQuery('more');
    }, [hasMore, runQuery]);

    useEffect(() => {
        if (!live || !sourceId) return;
        const iv = setInterval(() => {
            if (loadingRef.current) return;
            runQuery('replace', true);
        }, LIVE_INTERVAL_MS);
        return () => clearInterval(iv);
    }, [live, sourceId, runQuery]);

    // La sentinelle est en tête quand on remonte, en pied quand on part du début.
    useEffect(() => {
        if (!hasMore || loading) return;
        const sentinel = sentinelRef.current;
        const root = scrollRef.current;
        if (!sentinel || !root) return;
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries[0]?.isIntersecting) loadMore();
            },
            { root, rootMargin: '200px' }
        );
        observer.observe(sentinel);
        return () => observer.disconnect();
    }, [hasMore, loading, loadMore, lines.length]);

    /**
     * Le défilement se règle avant la peinture, sinon une page insérée en tête
     * fait sauter la ligne qu'on lisait.
     */
    useLayoutEffect(() => {
        const el = scrollRef.current;
        const action = scrollActionRef.current;
        scrollActionRef.current = null;
        if (!el || !action) return;
        if (action === 'bottom') el.scrollTop = el.scrollHeight;
        else if (action === 'top') el.scrollTop = 0;
        else el.scrollTop = el.scrollHeight - bottomGapRef.current;
    }, [lines]);

    const grouped = useMemo(() => {
        const g = new Map<string, DeviceLogSource[]>();
        for (const s of sources ?? []) {
            const key = KIND_GROUP[s.kind] ?? 'Autres';
            const list = g.get(key) ?? [];
            list.push(s);
            g.set(key, list);
        }
        // Les conteneurs arrivent dans l'ordre de `docker ps` (création
        // décroissante) : illisible passé quelques-uns. Les autres groupes gardent
        // leur ordre, qui est délibéré côté agent.
        const containers = g.get(CONTAINER_GROUP);
        containers?.sort(
            (a, b) =>
                Number(b.running ?? false) - Number(a.running ?? false) ||
                a.label.localeCompare(b.label, 'fr', { numeric: true })
        );
        return [...g.entries()];
    }, [sources]);

    const sourceOptions = useMemo<SearchSelectOption[]>(
        () =>
            grouped.flatMap(([group, list]) =>
                list.map((s) => ({
                    value: s.id,
                    label: s.label,
                    group,
                    detail: s.detail ?? undefined,
                    keywords: s.running ? RUNNING_KEYWORDS : undefined,
                    prefix:
                        s.kind === 'docker' ? (
                            <span className={`${styles.logDot} ${s.running ? styles.logDotOn : styles.logDotOff}`} />
                        ) : (
                            <span
                                className={`icon ${s.kind === 'syslog' ? 'icon-file' : 'icon-server'} ${styles.logKindIcon}`}
                            />
                        )
                }))
            ),
        [grouped]
    );
    // Une seule pastille ne trierait rien : la rangée n'apparaît qu'à partir de deux.
    const sourceFilters = useMemo(() => {
        const present = SOURCE_FILTERS.filter((f) => sourceOptions.some((o) => f.test(o)));
        return present.length >= 2 ? present : [];
    }, [sourceOptions]);

    const copyValue = useMemo(
        () =>
            lines
                .map(({ line }) =>
                    [formatTs(line.ts), line.level?.toUpperCase(), line.unit, line.message].filter(Boolean).join('  ')
                )
                .join('\n'),
        [lines]
    );

    // Les lignes affichées passent déjà le filtre de l'agent : il ne reste qu'à montrer où.
    const highlightRe = useMemo(() => {
        const term = search.trim();
        if (!term) return null;
        try {
            return new RegExp(regex ? term : escapeRegExp(term), 'gi');
        } catch {
            return null;
        }
    }, [search, regex]);

    if (sources === null) {
        return (
            <div className={styles.logsPanel}>
                {sourcesTimedOut ? (
                    <>
                        <p className={styles.logErr}>
                            L’appareil n’a pas répondu à l’inventaire de ses sources de logs.
                        </p>
                        <div className={styles.logToolbar}>
                            <Button variant='secondary' onClick={requestSources}>
                                Réessayer
                            </Button>
                        </div>
                    </>
                ) : (
                    <div className={styles.logViewWrap}>
                        <div className={styles.logView} />
                        <LoadingVeil label='Détection des sources de logs…' />
                    </div>
                )}
            </div>
        );
    }
    if (sources.length === 0) {
        return (
            <div className={styles.logsPanel}>
                <p className={styles.logHint}>Aucune source de logs détectée sur cet appareil.</p>
                <p className={styles.logHint}>{NO_CONTAINERS_HINT}</p>
                <div className={styles.logToolbar}>
                    <Button variant='secondary' onClick={requestSources} disabled={sourcesLoading}>
                        Réessayer
                    </Button>
                </div>
            </div>
        );
    }

    const sentinel = hasMore ? (
        <div ref={sentinelRef} className={styles.logSentinel} />
    ) : lines.length >= MAX_LOADED_LINES ? (
        <p className={styles.logSentinel}>
            Plafond de {MAX_LOADED_LINES.toLocaleString('fr-FR')} lignes atteint. Resserrez la recherche ou la fenêtre
            de temps.
        </p>
    ) : null;
    const showVeil = loading && !pendingRef.current.silent;

    return (
        <div className={styles.logsPanel}>
            <div className={styles.logToolbar}>
                <SearchSelect
                    value={sourceId}
                    options={sourceOptions}
                    filters={sourceFilters}
                    onChange={setSourceId}
                    aria-label='Source de logs'
                    placeholder='Choisir une source…'
                    searchPlaceholder='Chercher une source…'
                    className={styles.logSourceSelect}
                />
                <button
                    type='button'
                    className={styles.logToggle}
                    onClick={requestSources}
                    disabled={sourcesLoading}
                    title='Réinventorier les sources (conteneurs démarrés depuis, nouveaux fichiers…)'
                    aria-label='Réinventorier les sources'
                >
                    <span className={`icon icon-refresh ${sourcesLoading ? styles.spinning : ''}`} />
                </button>

                <TextInput
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder={regex ? 'Regex…' : 'Rechercher…'}
                    className={styles.logSearch}
                />
                <button
                    type='button'
                    className={`${styles.logToggle} ${regex ? styles.logToggleOn : ''}`}
                    onClick={() => setRegex((v) => !v)}
                    title='Interpréter la recherche comme une expression régulière'
                >
                    .*
                </button>

                <SearchSelect
                    value={levelMin}
                    options={LEVEL_OPTIONS}
                    onChange={setLevelMin}
                    aria-label='Niveau minimum'
                    className={styles.logLevelSelect}
                />

                {selectedSource?.kind === 'journald' && (
                    <TextInput
                        value={unit}
                        onChange={(e) => setUnit(e.target.value)}
                        placeholder='unité (ex. nginx.service)'
                        className={styles.logUnitInput}
                    />
                )}

                <button
                    type='button'
                    className={`${styles.logToggle} ${live ? styles.logToggleOn : ''}`}
                    onClick={() => setLive((v) => !v)}
                    title='Rafraîchissement automatique'
                >
                    <span className={`icon ${live ? 'icon-refresh ' + styles.spinning : 'icon-refresh'}`} />
                    Live
                </button>
                <Button variant='secondary' onClick={() => runQuery('replace')} disabled={loading}>
                    Actualiser
                </Button>
            </div>

            <div className={styles.logTimeRow}>
                {TIME_PRESETS.map((p) => (
                    <button
                        key={p.label}
                        type='button'
                        className={`${styles.logTimeBtn} ${sinceSec === p.seconds ? styles.logTimeBtnOn : ''}`}
                        onClick={() => setSinceSec(p.seconds)}
                    >
                        {p.label}
                    </button>
                ))}
                <div className={styles.logAnchorGroup}>
                    <button
                        type='button'
                        className={`${styles.logTimeBtn} ${anchor === 'oldest' ? styles.logTimeBtnOn : ''}`}
                        onClick={() => {
                            setLive(false);
                            setAnchor('oldest');
                        }}
                        title='Sauter aux toutes premières lignes du journal, sans charger ce qu’il y a entre'
                    >
                        Début du journal
                    </button>
                    <button
                        type='button'
                        className={`${styles.logTimeBtn} ${anchor === 'newest' ? styles.logTimeBtnOn : ''}`}
                        onClick={() => setAnchor('newest')}
                        title='Revenir aux lignes les plus récentes'
                    >
                        Plus récent
                    </button>
                </div>
                <span className={styles.logCount}>{`${lines.length} ligne${lines.length > 1 ? 's' : ''}`}</span>
                <CopyButton value={copyValue} label='Copier les lignes affichées' />
            </div>

            {!sources.some((s) => s.kind === 'docker') && <p className={styles.logHint}>{NO_CONTAINERS_HINT}</p>}

            <div className={styles.logViewWrap}>
                <div className={styles.logView} ref={scrollRef}>
                    {error ? (
                        <p className={styles.logErr}>{error}</p>
                    ) : lines.length === 0 && !loading ? (
                        <p className={styles.logHint}>Aucune ligne pour ces critères.</p>
                    ) : (
                        <>
                            {anchor === 'newest' && sentinel}
                            {lines.map(({ key, line: l }) => (
                                <div key={key} className={`${styles.logLine} ${(l.level && LINE_TONE[l.level]) || ''}`}>
                                    <span className={styles.logTs}>{formatTs(l.ts)}</span>
                                    {l.level && (
                                        <span className={`${styles.logLvl} ${LEVEL_CLASS[l.level]}`}>{l.level}</span>
                                    )}
                                    {l.unit && <span className={styles.logUnit}>{highlight(l.unit, highlightRe)}</span>}
                                    <span className={styles.logMsg}>{highlight(l.message, highlightRe)}</span>
                                </div>
                            ))}
                            {anchor === 'oldest' && sentinel}
                        </>
                    )}
                </div>
                {showVeil && (
                    <LoadingVeil
                        delayed
                        align={anchor === 'oldest' ? 'top' : 'center'}
                        label={lines.length === 0 ? 'Lecture du journal…' : undefined}
                    />
                )}
            </div>
        </div>
    );
}
