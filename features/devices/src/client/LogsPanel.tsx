import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { acquireMetrics, Button, onServerEvent, SelectInput, TextInput } from 'deveye-sdk-client';
import {
    DEVICE_LOG_LEVELS,
    DEVICE_LOG_LINES_EVENT,
    DEVICE_LOG_SOURCES_EVENT,
    deviceLogLinesPushSchema,
    deviceLogSourcesPushSchema,
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

/** Group label for the source <optgroup>, by source kind. */
const KIND_GROUP: Record<DeviceLogSourceKind, string> = {
    journald: 'Système',
    oslog: 'Système',
    eventlog: 'Système',
    syslog: 'Fichiers',
    docker: 'Conteneurs'
};

/**
 * Quand aucun conteneur n'est listé : l'agent ne peut pas distinguer « pas de
 * moteur » de « socket refusée », la note dit donc la condition.
 */
const NO_CONTAINERS_HINT =
    'Aucun conteneur listé. L’agent les énumère avec « docker ps » / « podman ps » : il lui faut ' +
    'donc accès au démon — service installé en root, ou son utilisateur dans le groupe « docker ».';

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

/**
 * Log viewer for one device: its log sources (system journal, one entry per
 * container, files), filtered queries against the selected one, a live mode.
 * Everything streams over the device's push channel, so the panel acquires the
 * shared live subscription.
 */
export function LogsPanel({ deviceId }: { deviceId: string }) {
    const [sources, setSources] = useState<DeviceLogSource[] | null>(null);
    const [sourcesLoading, setSourcesLoading] = useState(false);
    const [sourceId, setSourceId] = useState('');
    const [search, setSearch] = useState('');
    const [regex, setRegex] = useState(false);
    const [levelMin, setLevelMin] = useState<DeviceLogLevel | ''>('');
    const [unit, setUnit] = useState('');
    const [sinceSec, setSinceSec] = useState<number | null>(null);
    const [lines, setLines] = useState<DeviceLogLine[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [live, setLive] = useState(false);

    const queryIdRef = useRef('');
    const bufferRef = useRef<DeviceLogLine[]>([]);
    const scrollRef = useRef<HTMLDivElement>(null);
    /** Lu par le minuteur du mode direct, qui ne doit pas dépendre du rendu. */
    const loadingRef = useRef(false);
    loadingRef.current = loading;
    const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const clearWatchdog = useCallback(() => {
        if (watchdogRef.current !== null) {
            clearTimeout(watchdogRef.current);
            watchdogRef.current = null;
        }
    }, []);

    // Le chien de garde survivrait au démontage du panneau.
    useEffect(() => clearWatchdog, [clearWatchdog]);

    useEffect(() => acquireMetrics(deviceId), [deviceId]);

    const selectedSource = useMemo(() => sources?.find((s) => s.id === sourceId) ?? null, [sources, sourceId]);

    // Reset when the device changes; the effect below re-fetches its sources.
    useEffect(() => {
        setSources(null);
        setSourceId('');
        setLines([]);
        setError(null);
    }, [deviceId]);

    /** (Re)demande l'inventaire des sources : les conteneurs vont et viennent. */
    const requestSources = useCallback(() => {
        setSourcesLoading(true);
        void agent.send('agent.logSources', { deviceId }).catch(() => {
            setSources([]);
            setSourcesLoading(false);
        });
    }, [deviceId]);

    // Subscribe to the source/line pushes and ask for the source inventory.
    useEffect(() => {
        const offSources = onServerEvent(DEVICE_LOG_SOURCES_EVENT, deviceLogSourcesPushSchema, (d) => {
            if (d.deviceId !== deviceId) return;
            setSources(d.sources);
            setSourcesLoading(false);
            // Une source disparue entre deux inventaires ne doit pas rester
            // sélectionnée : la requête suivante échouerait.
            setSourceId((cur) => (d.sources.some((s) => s.id === cur) ? cur : (d.sources[0]?.id ?? '')));
        });
        const offLines = onServerEvent(DEVICE_LOG_LINES_EVENT, deviceLogLinesPushSchema, (d) => {
            if (d.deviceId !== deviceId || d.queryId !== queryIdRef.current) return;
            // Borné : sans `done` (un agent mort en plein flux), le tampon
            // grossirait à chaque interrogation du mode direct. On garde la queue.
            const merged = bufferRef.current.concat(d.lines);
            bufferRef.current = merged.length > MAX_BUFFERED_LINES ? merged.slice(-MAX_BUFFERED_LINES) : merged;
            if (d.done) {
                clearWatchdog();
                setLines(bufferRef.current);
                setLoading(false);
                setError(d.error ?? null);
            }
        });
        requestSources();
        return () => {
            offSources();
            offLines();
        };
    }, [deviceId, requestSources, clearWatchdog]);

    const runQuery = useCallback(() => {
        if (!sourceId) return;
        const queryId = crypto.randomUUID();
        queryIdRef.current = queryId;
        bufferRef.current = [];
        setLoading(true);
        setError(null);
        clearWatchdog();
        watchdogRef.current = setTimeout(() => {
            // Une interrogation plus récente est passée devant, avec son propre
            // chien de garde.
            if (queryIdRef.current !== queryId) return;
            setLoading(false);
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
                filter: Object.keys(filter).length ? filter : undefined
            })
            .catch((e) => {
                clearWatchdog();
                setLoading(false);
                setError(e instanceof Error ? e.message : 'Échec de la requête');
            });
    }, [deviceId, sourceId, search, regex, levelMin, unit, sinceSec, selectedSource, clearWatchdog]);

    // Debounced auto-run on any filter/source change.
    useEffect(() => {
        if (!sourceId) return;
        const t = setTimeout(runQuery, 300);
        return () => clearTimeout(t);
    }, [runQuery, sourceId]);

    /**
     * Mode direct : réinterroger périodiquement, jamais par-dessus une
     * interrogation en vol. Chaque relance change l'identifiant courant et le
     * routeur jette tout ce qui ne le porte pas : une source lente ne rendrait
     * plus jamais rien.
     */
    useEffect(() => {
        if (!live || !sourceId) return;
        const iv = setInterval(() => {
            if (loadingRef.current) return;
            runQuery();
        }, LIVE_INTERVAL_MS);
        return () => clearInterval(iv);
    }, [live, sourceId, runQuery]);

    // Stick to the bottom (newest) when results land.
    useEffect(() => {
        const el = scrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [lines]);

    const grouped = useMemo(() => {
        const g = new Map<string, DeviceLogSource[]>();
        for (const s of sources ?? []) {
            const key = KIND_GROUP[s.kind] ?? 'Autres';
            const list = g.get(key) ?? [];
            list.push(s);
            g.set(key, list);
        }
        return [...g.entries()];
    }, [sources]);

    if (sources === null) {
        return <p className={styles.logHint}>Détection des sources de logs…</p>;
    }
    if (sources.length === 0) {
        return (
            <div className={styles.logsPanel}>
                <p className={styles.logHint}>Aucune source de logs détectée sur cet appareil.</p>
                <p className={styles.logHint}>{NO_CONTAINERS_HINT}</p>
                <div className={styles.logToolbar}>
                    <Button variant='secondary' onClick={requestSources} disabled={sourcesLoading}>
                        {sourcesLoading ? '…' : 'Réessayer'}
                    </Button>
                </div>
            </div>
        );
    }

    return (
        <div className={styles.logsPanel}>
            <div className={styles.logToolbar}>
                <SelectInput
                    value={sourceId}
                    onChange={(e) => setSourceId(e.target.value)}
                    className={styles.logSourceSelect}
                    aria-label='Source de logs'
                >
                    {grouped.map(([group, list]) => (
                        <optgroup key={group} label={group}>
                            {list.map((s) => (
                                <option key={s.id} value={s.id}>
                                    {s.label}
                                    {s.kind === 'docker' ? (s.running ? ' ●' : ' ○') : ''}
                                </option>
                            ))}
                        </optgroup>
                    ))}
                </SelectInput>
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

                <SelectInput
                    value={levelMin}
                    onChange={(e) => setLevelMin(e.target.value as DeviceLogLevel | '')}
                    className={styles.logLevelSelect}
                    aria-label='Niveau minimum'
                >
                    <option value=''>Tous niveaux</option>
                    {DEVICE_LOG_LEVELS.map((l) => (
                        <option key={l} value={l}>
                            ≥ {LEVEL_LABELS[l]}
                        </option>
                    ))}
                </SelectInput>

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
                <Button variant='secondary' onClick={runQuery} disabled={loading}>
                    {loading ? '…' : 'Actualiser'}
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
                <span className={styles.logCount}>
                    {loading ? 'Chargement…' : `${lines.length} ligne${lines.length > 1 ? 's' : ''}`}
                </span>
            </div>

            {!sources.some((s) => s.kind === 'docker') && <p className={styles.logHint}>{NO_CONTAINERS_HINT}</p>}

            <div className={styles.logView} ref={scrollRef}>
                {error ? (
                    <p className={styles.logErr}>{error}</p>
                ) : lines.length === 0 && !loading ? (
                    <p className={styles.logHint}>Aucune ligne pour ces critères.</p>
                ) : (
                    lines.map((l, i) => (
                        <div key={i} className={styles.logLine}>
                            <span className={styles.logTs}>
                                {l.ts ? new Date(l.ts).toLocaleString('fr-FR', { hour12: false }) : '—'}
                            </span>
                            {l.level && <span className={`${styles.logLvl} ${LEVEL_CLASS[l.level]}`}>{l.level}</span>}
                            {l.unit && <span className={styles.logUnit}>{l.unit}</span>}
                            <span className={styles.logMsg}>{l.message}</span>
                        </div>
                    ))
                )}
            </div>
        </div>
    );
}
