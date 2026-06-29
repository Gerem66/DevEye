import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ws } from '@/api/ws';
import { acquireMetrics } from '@/stores/metricsSubscription';
import Button from '@/Components/Button';
import TextInput from '@/Components/TextInput';
import SelectInput from '@/Components/SelectInput';
import {
    DEVICE_LOG_LEVELS,
    DEVICE_LOG_LINES_EVENT,
    DEVICE_LOG_SOURCES_EVENT,
    type DeviceLogFilter,
    type DeviceLogLevel,
    type DeviceLogLine,
    type DeviceLogLinesPush,
    type DeviceLogSource,
    type DeviceLogSourceKind,
    type DeviceLogSourcesPush
} from 'deveye-types';
import styles from './Monitoring.module.css';

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
    docker: 'Conteneurs Docker'
};

const TIME_PRESETS: { label: string; seconds: number | null }[] = [
    { label: 'Tout', seconds: null },
    { label: '15 min', seconds: 15 * 60 },
    { label: '1 h', seconds: 60 * 60 },
    { label: '6 h', seconds: 6 * 60 * 60 },
    { label: '24 h', seconds: 24 * 60 * 60 }
];

const LIVE_INTERVAL_MS = 3000;

/**
 * On-device log viewer for one device. Lists the device's log sources (system
 * journal, Docker containers, files…), runs filtered queries against the selected
 * one, and renders the matched lines. Advanced search: free text or regex, a
 * severity floor, a journald unit, and a time window — plus a live (auto-refresh)
 * mode. Everything streams over the device's push channel (`device.logSources` /
 * `device.logLines`), so the panel acquires the shared live subscription.
 */
export function LogsPanel({ deviceId }: { deviceId: string }) {
    const [sources, setSources] = useState<DeviceLogSource[] | null>(null);
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

    useEffect(() => acquireMetrics(deviceId), [deviceId]);

    const selectedSource = useMemo(() => sources?.find((s) => s.id === sourceId) ?? null, [sources, sourceId]);

    // Reset when the device changes; the effect below re-fetches its sources.
    useEffect(() => {
        setSources(null);
        setSourceId('');
        setLines([]);
        setError(null);
    }, [deviceId]);

    // Subscribe to the source/line pushes and ask for the source inventory.
    useEffect(() => {
        const off = ws.onMessage((msg) => {
            if (msg.command === DEVICE_LOG_SOURCES_EVENT && msg.payload.ok) {
                const d = msg.payload.data as DeviceLogSourcesPush;
                if (d.deviceId !== deviceId) return;
                setSources(d.sources);
                setSourceId((cur) => cur || d.sources[0]?.id || '');
            } else if (msg.command === DEVICE_LOG_LINES_EVENT && msg.payload.ok) {
                const d = msg.payload.data as DeviceLogLinesPush;
                if (d.deviceId !== deviceId || d.queryId !== queryIdRef.current) return;
                bufferRef.current = bufferRef.current.concat(d.lines);
                if (d.done) {
                    setLines(bufferRef.current);
                    setLoading(false);
                    setError(d.error ?? null);
                }
            }
        });
        void ws.send('device.logSources', { deviceId }).catch(() => setSources([]));
        return off;
    }, [deviceId]);

    const runQuery = useCallback(() => {
        if (!sourceId) return;
        const queryId = crypto.randomUUID();
        queryIdRef.current = queryId;
        bufferRef.current = [];
        setLoading(true);
        setError(null);
        const filter: DeviceLogFilter = {};
        if (search.trim()) {
            filter.search = search.trim();
            if (regex) filter.regex = true;
        }
        if (levelMin) filter.levelMin = levelMin;
        if (unit.trim() && selectedSource?.kind === 'journald') filter.unit = unit.trim();
        if (sinceSec) filter.since = Math.floor(Date.now() / 1000) - sinceSec;
        ws.send('device.logQuery', {
            deviceId,
            sourceId,
            queryId,
            filter: Object.keys(filter).length ? filter : undefined
        }).catch((e) => {
            setLoading(false);
            setError(e instanceof Error ? e.message : 'Échec de la requête');
        });
    }, [deviceId, sourceId, search, regex, levelMin, unit, sinceSec, selectedSource]);

    // Debounced auto-run on any filter/source change.
    useEffect(() => {
        if (!sourceId) return;
        const t = setTimeout(runQuery, 300);
        return () => clearTimeout(t);
    }, [runQuery, sourceId]);

    // Live mode: re-run the query on a timer.
    useEffect(() => {
        if (!live || !sourceId) return;
        const iv = setInterval(runQuery, LIVE_INTERVAL_MS);
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
        return <p className={styles.logHint}>Aucune source de logs détectée sur cet appareil.</p>;
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
