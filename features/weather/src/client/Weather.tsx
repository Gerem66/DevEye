import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { motion, Reorder, useDragControls } from 'framer-motion';
import {
    Button,
    Dialog,
    featureApi,
    FeatureSettingsButton,
    TextInput,
    useLiveOutline,
    useLiveSegment
} from 'deveye-sdk-client';
import { useWeather, syncWeatherLocations } from './store';
import { wmoIcon } from './wmoIcon';
import type { WeatherLocation, WeatherProvider, WeatherReport } from 'deveye-types';
import { manifest } from '../manifest';
import styles from './Weather.module.css';

const api = featureApi(manifest);

const REFRESH_MS = 10 * 60 * 1000;

/** Human label for each weather provider. */
const PROVIDER_LABELS: Record<WeatherProvider, string> = {
    'open-meteo': 'Open-Meteo',
    openweathermap: 'OpenWeatherMap'
};

/**
 * Providers offered in the settings popup. To support another provider, add a
 * row here and a matching adapter server-side — no other client change needed.
 */
const PROVIDERS: { value: WeatherProvider; label: string; needsKey: boolean }[] = [
    { value: 'open-meteo', label: 'Open-Meteo', needsKey: false },
    { value: 'openweathermap', label: 'OpenWeatherMap', needsKey: true }
];

/** Local date + time in the location's timezone (e.g. "lundi 16 juin · 14:32"). */
function localDateTime(report: WeatherReport): { date: string; time: string } {
    const when = new Date(report.fetchedAt * 1000);
    try {
        return {
            date: when.toLocaleDateString('fr-FR', {
                timeZone: report.timezone,
                weekday: 'long',
                day: 'numeric',
                month: 'long'
            }),
            time: when.toLocaleTimeString('fr-FR', {
                timeZone: report.timezone,
                hour: '2-digit',
                minute: '2-digit'
            })
        };
    } catch {
        return { date: '', time: '' };
    }
}

/** Hour label (e.g. "14h") from a local ISO time like "2026-06-17T14:00". */
function hourLabel(time: string): string {
    const hh = time.slice(11, 13);
    return hh ? `${Number(hh)}h` : time;
}

/** True when `time` (local ISO in `tz`) falls in the current hour of that timezone. */
function isCurrentHour(time: string, tz: string): boolean {
    const nowLocal = new Date().toLocaleString('sv-SE', { timeZone: tz });
    // Compare "YYYY-MM-DDTHH" against "YYYY-MM-DD HH".
    return time.slice(0, 13).replace('T', ' ') === nowLocal.slice(0, 13);
}

/** Left padding kept before the aligned "now" card so it doesn't sit flush against the edge. */
const NOW_ALIGN_OFFSET = 8;

/**
 * Hour-by-hour row. On the first reveal for a location the current hour is
 * aligned near the left edge (so "now" + upcoming hours read first); afterwards
 * the user's own scroll position is remembered and restored across popup
 * open/close — the feature stays mounted but the DOM's `scrollLeft` is lost when
 * the host is hidden, so we persist it ourselves.
 */
function HourlyRow({ report }: { report: WeatherReport }) {
    const rowRef = useRef<HTMLDivElement>(null);
    const nowRef = useRef<HTMLDivElement>(null);
    // The user's last scroll position, persisted across hide/show. `null` means
    // we haven't aligned this location yet and should snap to "now" on reveal.
    const savedScroll = useRef<number | null>(null);

    // New location → forget the remembered position so the next reveal re-centres on "now".
    useLayoutEffect(() => {
        savedScroll.current = null;
    }, [report.locationId]);

    useLayoutEffect(() => {
        const row = rowRef.current;
        if (!row) return;

        // Apply the right scroll position whenever the row becomes visible: restore
        // the user's saved offset, or snap to "now" the first time. Geometry is only
        // real once visible, so IntersectionObserver is the reliable trigger.
        const applyScroll = () => {
            if (row.clientWidth === 0) return;
            if (savedScroll.current !== null) {
                row.scrollLeft = savedScroll.current;
            } else if (nowRef.current) {
                row.scrollLeft = Math.max(0, nowRef.current.offsetLeft - row.offsetLeft - NOW_ALIGN_OFFSET);
                savedScroll.current = row.scrollLeft;
            }
        };

        const io = new IntersectionObserver(
            (entries) => {
                if (entries.some((e) => e.isIntersecting)) applyScroll();
            },
            { threshold: 0.1 }
        );
        io.observe(row);
        applyScroll();

        // Remember manual scrolling so it survives the next hide/show cycle.
        const onScroll = () => {
            if (row.clientWidth > 0) savedScroll.current = row.scrollLeft;
        };
        row.addEventListener('scroll', onScroll, { passive: true });

        return () => {
            io.disconnect();
            row.removeEventListener('scroll', onScroll);
        };
    }, [report.locationId]);

    return (
        <div className={styles.hourlyRow} ref={rowRef}>
            {report.hourly.map((hour) => {
                const current = isCurrentHour(hour.time, report.timezone);
                return (
                    <div
                        key={hour.time}
                        ref={current ? nowRef : undefined}
                        className={`${styles.hourlyCard} ${current ? styles.hourlyCurrent : ''}`}
                    >
                        <span className={styles.hourlyTime}>{current ? 'Maint.' : hourLabel(hour.time)}</span>
                        <span className={styles.hourlyIcon}>{wmoIcon(hour.code)}</span>
                        <span className={styles.hourlyTemp}>{Math.round(hour.temperature)}°</span>
                        {hour.precipitationProbability !== null && hour.precipitationProbability > 0 && (
                            <span
                                className={styles.hourlyPrecip}
                                title={`Probabilité de pluie : ${hour.precipitationProbability} %`}
                            >
                                ☔ {hour.precipitationProbability}%
                            </span>
                        )}
                    </div>
                );
            })}
        </div>
    );
}

/** Settings popup for one location: provider choice + API key. Uses the shared Dialog. */
function WeatherSettingsModal({
    loc,
    onClose,
    onSave
}: {
    loc: WeatherLocation;
    onClose: () => void;
    onSave: (id: string, patch: { provider: WeatherProvider; apiKey?: string }) => Promise<void>;
}) {
    const [provider, setProvider] = useState<WeatherProvider>(loc.provider);
    const [apiKey, setApiKey] = useState('');
    // Whether the key field was touched; if not, we leave the stored key as-is.
    const [keyTouched, setKeyTouched] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const needsKey = provider !== 'open-meteo';

    const submit = async () => {
        if (saving) return;
        setSaving(true);
        setError(null);
        try {
            await onSave(loc.id, {
                provider,
                apiKey: keyTouched ? apiKey.trim() : undefined
            });
            onClose();
        } catch {
            setError('Échec de l’enregistrement. Vérifiez la clé API et le fournisseur.');
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog
            open
            onClose={onClose}
            title={`Réglages — ${loc.label}`}
            onSubmit={() => void submit()}
            footer={
                <>
                    <Button variant='secondary' onClick={onClose} disabled={saving}>
                        Annuler
                    </Button>
                    <Button onClick={() => void submit()} disabled={saving}>
                        {saving ? 'Enregistrement…' : 'Enregistrer'}
                    </Button>
                </>
            }
        >
            <div className={styles.settingsForm}>
                <span className={styles.settingsLabel}>Fournisseur météo</span>
                <div className={styles.providerOptions}>
                    {PROVIDERS.map((p) => (
                        <label
                            key={p.value}
                            className={`${styles.providerOption} ${provider === p.value ? styles.providerOptionActive : ''}`}
                        >
                            <input
                                type='radio'
                                name='provider'
                                value={p.value}
                                checked={provider === p.value}
                                onChange={() => setProvider(p.value)}
                            />
                            <span className={styles.providerOptionName}>{p.label}</span>
                            <span className={styles.providerOptionMeta}>
                                {p.needsKey ? 'Clé API requise' : 'Gratuit, sans clé'}
                            </span>
                        </label>
                    ))}
                </div>

                {needsKey && (
                    <label className={styles.settingsField}>
                        <span className={styles.settingsLabel}>Clé API</span>
                        <TextInput
                            type='password'
                            enableShowHideButton
                            autoComplete='off'
                            placeholder={
                                loc.hasApiKey ? '•••••••• (laisser vide pour conserver)' : 'Collez votre clé API'
                            }
                            value={apiKey}
                            onChange={(e) => {
                                setApiKey(e.target.value);
                                setKeyTouched(true);
                            }}
                        />
                        {loc.hasApiKey && keyTouched && apiKey.trim() === '' && (
                            <span className={styles.settingsHint}>La clé enregistrée sera supprimée.</span>
                        )}
                    </label>
                )}

                {error && <p className={styles.settingsError}>{error}</p>}
            </div>
        </Dialog>
    );
}

export function WeatherWidget() {
    const { report, loading, primary } = useWeather();

    if (loading && !report) return <div className={styles.widgetLoading}>Chargement…</div>;
    if (!primary || !report?.current)
        return (
            <div className={styles.widgetEmpty}>
                <span className={styles.widgetEmptyIcon}>🌡️</span>
                <span>Aucune météo configurée</span>
            </div>
        );

    return (
        <div className={styles.widgetContent}>
            <div className={styles.mainTemp}>
                <span className={styles.weatherIcon}>{wmoIcon(report.current.code)}</span>
                <span className={styles.temperature}>{Math.round(report.current.temperature)}°</span>
            </div>
            <div className={styles.location}>{report.label}</div>
            <div className={styles.details}>
                {report.current.apparentTemperature !== null && (
                    <span>Ressenti {Math.round(report.current.apparentTemperature)}°</span>
                )}
                {report.current.humidity !== null && <span>💧 {report.current.humidity}%</span>}
            </div>
        </div>
    );
}

/** A draggable location tab: select, set-primary and remove controls. */
function LocationTab({
    loc,
    active,
    onSelect,
    onSetPrimary,
    onRemove
}: {
    loc: WeatherLocation;
    active: boolean;
    onSelect: () => void;
    onSetPrimary: () => void;
    onRemove: () => void;
}) {
    const controls = useDragControls();
    // Quelqu'un consulte cette ville : sa couleur sur l'onglet.
    const outline = useLiveOutline('l1', loc.id);
    return (
        <Reorder.Item
            value={loc}
            dragListener={false}
            dragControls={controls}
            {...outline}
            className={`${styles.locationTabWrapper} ${active ? styles.activeTab : ''} ${
                loc.isPrimary ? styles.primaryTab : ''
            }`}
            whileDrag={{ scale: 1.04 }}
        >
            <button
                className={styles.dragHandle}
                onPointerDown={(e) => controls.start(e)}
                aria-label='Déplacer'
                title='Glisser pour réordonner'
            >
                <span className='icon icon-drag' />
            </button>
            <button className={styles.locationTab} onClick={onSelect}>
                {loc.label}
            </button>
            <button
                className={`${styles.primaryBtn} ${loc.isPrimary ? styles.isPrimary : ''}`}
                onClick={(e) => {
                    e.stopPropagation();
                    onSetPrimary();
                }}
                aria-label='Ville principale'
                title={loc.isPrimary ? 'Ville principale' : 'Définir comme ville principale'}
            >
                {loc.isPrimary ? '★' : '☆'}
            </button>
            {!loc.isPrimary && (
                <button
                    className={styles.removeTabBtn}
                    onClick={(e) => {
                        e.stopPropagation();
                        onRemove();
                    }}
                    aria-label='Supprimer'
                >
                    ×
                </button>
            )}
        </Reorder.Item>
    );
}

export default function Weather() {
    const [locations, setLocations] = useState<WeatherLocation[]>([]);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [report, setReport] = useState<WeatherReport | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadingReport, setLoadingReport] = useState(false);
    const [searchInput, setSearchInput] = useState('');
    const [adding, setAdding] = useState(false);
    const [addError, setAddError] = useState<string | null>(null);
    // The location whose settings popup is open, if any.
    const [settingsFor, setSettingsFor] = useState<WeatherLocation | null>(null);

    // Le niveau profond de Météo : la ville consultée.
    const liveTarget = useLiveSegment('l1', selectedId);

    // The order persisted on the server; lets us skip a redundant reorder call
    // when a drag ends without actually changing anything.
    const persistedOrder = useRef<string>('');

    const loadReport = useCallback(async (id: string, opts?: { silent?: boolean }) => {
        if (!opts?.silent) setLoadingReport(true);
        try {
            const res = await api.send('weather.get', { id });
            setReport(res.report);
        } catch {
            if (!opts?.silent) setReport(null);
        } finally {
            if (!opts?.silent) setLoadingReport(false);
        }
    }, []);

    const applyLocations = useCallback((next: WeatherLocation[]) => {
        setLocations(next);
        persistedOrder.current = next.map((l) => l.id).join(',');
        syncWeatherLocations(next);
    }, []);

    // Initial load: list locations, select the first, fetch its report.
    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const res = await api.send('weather.list', {});
                if (cancelled) return;
                setLocations(res.locations);
                persistedOrder.current = res.locations.map((l) => l.id).join(',');
                const first = res.locations[0];
                if (first) {
                    setSelectedId(first.id);
                    await loadReport(first.id);
                }
            } catch {
                // ignore
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [loadReport]);

    // Rejoindre quelqu'un : la cible est redonnée à chaque rendu tant qu'elle
    // n'est pas atteinte, il suffit donc d'attendre que la liste soit chargée.
    useEffect(() => {
        if (!liveTarget?.value) return;
        const id = liveTarget.value;
        if (!locations.some((l) => l.id === id)) return;
        setSelectedId(id);
        void loadReport(id);
    }, [liveTarget, locations, loadReport]);

    // Keep the selected report fresh in the background.
    useEffect(() => {
        if (!selectedId) return;
        const t = setInterval(() => void loadReport(selectedId, { silent: true }), REFRESH_MS);
        return () => clearInterval(t);
    }, [selectedId, loadReport]);

    const handleSelectLocation = async (id: string) => {
        setSelectedId(id);
        await loadReport(id);
    };

    const handleAdd = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!searchInput.trim()) return;
        setAdding(true);
        setAddError(null);
        try {
            const res = await api.send('weather.add', {
                query: searchInput.trim(),
                format: 'current',
                days: 7,
                provider: 'open-meteo'
            });
            applyLocations([...locations, res.location]);
            setSearchInput('');
            setSelectedId(res.location.id);
            await loadReport(res.location.id);
        } catch {
            setAddError('Ville introuvable. Vérifiez l’orthographe et réessayez.');
        } finally {
            setAdding(false);
        }
    };

    const handleRemove = async (id: string) => {
        try {
            const res = await api.send('weather.remove', { id });
            const next = locations.filter((l) => l.id !== res.id);
            applyLocations(next);
            if (selectedId === id) {
                const fallback = next[0] ?? null;
                setSelectedId(fallback?.id ?? null);
                setReport(null);
                if (fallback) await loadReport(fallback.id);
            }
        } catch {
            // ignore
        }
    };

    const handleSetPrimary = async (id: string) => {
        // Optimistic flag flip; the server response reconciles the full list.
        setLocations((prev) => prev.map((l) => ({ ...l, isPrimary: l.id === id })));
        try {
            const res = await api.send('weather.setPrimary', { id });
            applyLocations(res.locations);
        } catch {
            // ignore — next list refresh reconciles
        }
    };

    // Save provider/API-key changes from the settings popup. `apiKey` undefined
    // leaves the key untouched; "" clears it; a string sets it.
    const handleSaveSettings = async (id: string, patch: { provider: WeatherProvider; apiKey?: string }) => {
        const res = await api.send('weather.update', { id, ...patch });
        applyLocations(locations.map((l) => (l.id === res.location.id ? res.location : l)));
        if (selectedId === id) await loadReport(id);
    };

    // Persist a drag-reorder once it settles, if the order actually changed.
    const persistOrder = async () => {
        const order = locations.map((l) => l.id);
        if (order.join(',') === persistedOrder.current) return;
        persistedOrder.current = order.join(',');
        try {
            const res = await api.send('weather.reorder', { ids: order });
            applyLocations(res.locations);
        } catch {
            // ignore
        }
    };

    return (
        <div className={styles.container}>
            {/* L'en-tête commun à toutes les features : le titre à gauche, les
                actions à droite, dont le bouton de réglages commun. Ses clés
                d'espace n'avaient aucun écran ; elles vivent dans Sources. */}
            <div className={styles.header}>
                <h2 className={styles.title}>Météo</h2>
                <FeatureSettingsButton scope={{ kind: 'feature', feature: 'weather' }} />
            </div>

            <form className={styles.searchForm} onSubmit={handleAdd}>
                <input
                    type='text'
                    className={styles.searchInput}
                    placeholder='Ajouter une ville…'
                    value={searchInput}
                    onChange={(e) => {
                        setSearchInput(e.target.value);
                        if (addError) setAddError(null);
                    }}
                />
                <button type='submit' className={styles.searchBtn} disabled={adding}>
                    {adding ? <span className={styles.spinner} /> : <span className='icon icon-plus' />}
                </button>
            </form>

            {addError && <div className={styles.errorBanner}>{addError}</div>}

            {loading ? (
                <div className={styles.loader}>Chargement…</div>
            ) : locations.length === 0 ? (
                <div className={styles.empty}>
                    <span className={styles.emptyIcon}>🌡️</span>
                    <p>Ajoutez une ville pour voir la météo</p>
                </div>
            ) : (
                <div className={styles.weatherContent}>
                    {/* Location tabs — draggable to reorder, star to pick primary */}
                    <Reorder.Group
                        axis='x'
                        values={locations}
                        onReorder={setLocations}
                        className={styles.locationTabs}
                        onPointerUp={() => void persistOrder()}
                    >
                        {locations.map((loc) => (
                            <LocationTab
                                key={loc.id}
                                loc={loc}
                                active={loc.id === selectedId}
                                onSelect={() => void handleSelectLocation(loc.id)}
                                onSetPrimary={() => void handleSetPrimary(loc.id)}
                                onRemove={() => void handleRemove(loc.id)}
                            />
                        ))}
                    </Reorder.Group>

                    {/* Report */}
                    {loadingReport ? (
                        <div className={styles.loader}>Chargement du rapport…</div>
                    ) : report?.current ? (
                        <motion.div
                            key={report.locationId}
                            className={styles.currentWeather}
                            initial={{ opacity: 0, y: 16 }}
                            animate={{ opacity: 1, y: 0 }}
                        >
                            <div className={styles.currentMain}>
                                <span className={styles.bigIcon}>{wmoIcon(report.current.code)}</span>
                                <div className={styles.tempBlock}>
                                    <span className={styles.bigTemp}>{Math.round(report.current.temperature)}°C</span>
                                    <span className={styles.locationLarge}>{report.label}</span>
                                </div>
                                {(() => {
                                    const { date, time } = localDateTime(report);
                                    return (
                                        <span className={styles.localDate}>
                                            <span className={styles.localDateDay}>{date}</span>
                                            <span className={styles.localDateTime}>{time}</span>
                                        </span>
                                    );
                                })()}
                            </div>

                            <div className={styles.detailsGrid}>
                                {report.current.apparentTemperature !== null && (
                                    <div className={styles.detailCard}>
                                        <span className={styles.detailIcon}>🌡️</span>
                                        <span className={styles.detailValue}>
                                            {Math.round(report.current.apparentTemperature)}°
                                        </span>
                                        <span className={styles.detailLabel}>Ressenti</span>
                                    </div>
                                )}
                                {report.current.humidity !== null && (
                                    <div className={styles.detailCard}>
                                        <span className={styles.detailIcon}>💧</span>
                                        <span className={styles.detailValue}>{report.current.humidity}%</span>
                                        <span className={styles.detailLabel}>Humidité</span>
                                    </div>
                                )}
                                {report.current.windSpeed !== null && (
                                    <div className={styles.detailCard}>
                                        <span className={styles.detailIcon}>💨</span>
                                        <span className={styles.detailValue}>{report.current.windSpeed} km/h</span>
                                        <span className={styles.detailLabel}>Vent</span>
                                    </div>
                                )}
                            </div>

                            {report.hourly.length > 0 && (
                                <div className={styles.forecastSection}>
                                    <h3 className={styles.forecastTitle}>Aujourd’hui</h3>
                                    <HourlyRow report={report} />
                                </div>
                            )}

                            {report.daily.length > 0 && (
                                <div className={styles.forecastSection}>
                                    <h3 className={styles.forecastTitle}>Prévisions</h3>
                                    <div className={styles.forecastGrid}>
                                        {report.daily.map((day, i) => (
                                            <motion.div
                                                key={day.date}
                                                className={styles.forecastCard}
                                                initial={{ opacity: 0, y: 16 }}
                                                animate={{ opacity: 1, y: 0 }}
                                                transition={{ delay: i * 0.06 }}
                                            >
                                                <span className={styles.forecastDay}>
                                                    {new Date(day.date).toLocaleDateString('fr-FR', {
                                                        weekday: 'short'
                                                    })}
                                                    <span className={styles.forecastDate}>
                                                        {new Date(day.date).toLocaleDateString('fr-FR', {
                                                            day: 'numeric',
                                                            month: 'numeric'
                                                        })}
                                                    </span>
                                                </span>
                                                <span className={styles.forecastIcon}>{wmoIcon(day.code)}</span>
                                                <div className={styles.forecastTemps}>
                                                    <span className={styles.maxTemp}>{Math.round(day.tempMax)}°</span>
                                                    <span className={styles.minTemp}>{Math.round(day.tempMin)}°</span>
                                                </div>
                                            </motion.div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            <div className={styles.providerBar}>
                                <span className={styles.providerNote}>via {PROVIDER_LABELS[report.provider]}</span>
                                <button
                                    type='button'
                                    className={styles.providerEdit}
                                    onClick={() => {
                                        const loc = locations.find((l) => l.id === report.locationId);
                                        if (loc) setSettingsFor(loc);
                                    }}
                                >
                                    Modifier
                                </button>
                            </div>
                        </motion.div>
                    ) : (
                        <div className={styles.empty}>
                            <p>Impossible de récupérer le rapport météo</p>
                        </div>
                    )}
                </div>
            )}

            {settingsFor && (
                <WeatherSettingsModal
                    loc={settingsFor}
                    onClose={() => setSettingsFor(null)}
                    onSave={handleSaveSettings}
                />
            )}
        </div>
    );
}
