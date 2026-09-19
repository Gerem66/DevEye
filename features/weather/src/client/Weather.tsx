import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { motion, Reorder, useDragControls } from 'framer-motion';
import {
    FeatureSettingsButton,
    onResourceChange,
    useDismissLayer,
    useLiveOutline,
    useLiveSegment
} from 'deveye-sdk-client';
import { useWeather, syncWeatherLocations } from './store';
import { wmoIcon } from './wmoIcon';
import { isKeyRefused, PROVIDER_META, providerFailure, selectableProviders } from './providers';
import type { WeatherHour, WeatherLocation, WeatherProvider, WeatherReport } from '../contracts/domain';
import styles from './Weather.module.css';
import { api } from './api';

const REFRESH_MS = 10 * 60 * 1000;

/** La date et l'heure du relevé dans le fuseau de la ville (« lundi 16 juin », « 14:32 »). */
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

/** Le libellé d'un créneau (« 14h ») depuis son heure locale ISO (« 2026-06-17T14:00 »). */
function hourLabel(time: string): string {
    const hh = time.slice(11, 13);
    return hh ? `${Number(hh)}h` : time;
}

/**
 * L'indice du créneau qui vaut « maintenant » : le plus proche de l'heure locale,
 * et non l'heure exacte. Un relevé à pas de trois heures ne porte pas toujours
 * l'heure courante, et laisser la rangée sans repère la rend illisible.
 */
function currentHourIndex(hours: WeatherHour[], tz: string): number {
    let nowLocal: string;
    try {
        nowLocal = new Date().toLocaleString('sv-SE', { timeZone: tz });
    } catch {
        return -1;
    }
    // Les deux côtés sont des horloges murales : les lire en UTC les compare
    // entre eux sans jamais reconvertir de fuseau.
    const now = Date.parse(`${nowLocal.slice(0, 10)}T${nowLocal.slice(11, 19)}Z`);
    if (Number.isNaN(now)) return -1;

    let best = -1;
    let bestGap = Infinity;
    hours.forEach((hour, i) => {
        const at = Date.parse(`${hour.time}:00Z`);
        if (Number.isNaN(at)) return;
        const gap = Math.abs(at - now);
        if (gap < bestGap) {
            bestGap = gap;
            best = i;
        }
    });
    return best;
}

/** La marge gardée à gauche de la carte « maintenant », pour qu'elle ne colle pas au bord. */
const NOW_ALIGN_OFFSET = 8;

/**
 * La rangée heure par heure. À la première apparition, « maintenant » s'aligne
 * près du bord gauche ; ensuite la position de défilement est rendue à chaque
 * réouverture de la popup, le `scrollLeft` du DOM se perdant tant que l'hôte est
 * masqué.
 */
function HourlyRow({ report }: { report: WeatherReport }) {
    const rowRef = useRef<HTMLDivElement>(null);
    const nowRef = useRef<HTMLDivElement>(null);
    // La dernière position de défilement. `null` : cette ville n'a pas encore été
    // alignée, la prochaine apparition se cale sur « maintenant ».
    const savedScroll = useRef<number | null>(null);

    useLayoutEffect(() => {
        savedScroll.current = null;
    }, [report.locationId]);

    useLayoutEffect(() => {
        const row = rowRef.current;
        if (!row) return;

        // La géométrie n'est vraie qu'une fois la rangée visible : c'est
        // l'IntersectionObserver qui donne le bon moment pour poser le défilement.
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

        const onScroll = () => {
            if (row.clientWidth > 0) savedScroll.current = row.scrollLeft;
        };
        row.addEventListener('scroll', onScroll, { passive: true });

        return () => {
            io.disconnect();
            row.removeEventListener('scroll', onScroll);
        };
    }, [report.locationId]);

    const nowIndex = currentHourIndex(report.hourly, report.timezone);

    return (
        <div className={styles.hourlyRow} ref={rowRef}>
            {report.hourly.map((hour, i) => {
                const current = i === nowIndex;
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

/**
 * La ligne de source, en bas de la fiche. Le nom du fournisseur ouvre le choix,
 * et ne devient cliquable que si l'espace a de quoi choisir.
 */
function ProviderBar({
    provider,
    held,
    onChange
}: {
    provider: WeatherProvider;
    held: Record<string, boolean>;
    onChange: (provider: WeatherProvider) => void;
}) {
    const [open, setOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);
    const options = selectableProviders(held);

    useDismissLayer(open, () => setOpen(false));

    useEffect(() => {
        if (!open) return;
        const onPointerDown = (e: MouseEvent) => {
            if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener('mousedown', onPointerDown);
        return () => document.removeEventListener('mousedown', onPointerDown);
    }, [open]);

    if (options.length < 2) {
        return (
            <div className={styles.providerBar}>
                <span className={styles.providerNote}>via {PROVIDER_META[provider].label}</span>
            </div>
        );
    }

    return (
        <div className={styles.providerBar} ref={rootRef}>
            <span className={styles.providerNote}>via</span>
            <button
                type='button'
                className={styles.providerPick}
                onClick={() => setOpen((v) => !v)}
                aria-haspopup='menu'
                aria-expanded={open}
            >
                {PROVIDER_META[provider].label}
            </button>
            {open && (
                <div className={styles.providerMenu} role='menu'>
                    {options.map((p) => (
                        <button
                            key={p}
                            type='button'
                            role='menuitem'
                            className={`${styles.providerMenuItem} ${p === provider ? styles.providerMenuItemActive : ''}`}
                            aria-current={p === provider}
                            onClick={() => {
                                setOpen(false);
                                if (p !== provider) onChange(p);
                            }}
                        >
                            {PROVIDER_META[p].label}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}

export function WeatherWidget() {
    const { report, loading, primary } = useWeather();

    if (loading && !report) return <div className={styles.widgetLoading}>Chargement…</div>;
    if (!primary)
        return (
            <div className={styles.widgetEmpty}>
                <span className={styles.widgetEmptyIcon}>🌡️</span>
                <span>Aucune météo configurée</span>
            </div>
        );
    // Une ville est bien là : c'est le relevé qui manque, souvent faute de clé.
    if (!report?.current)
        return (
            <div className={styles.widgetEmpty}>
                <span className={styles.widgetEmptyIcon}>🌡️</span>
                <span>Relevé indisponible</span>
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
    const [reportError, setReportError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadingReport, setLoadingReport] = useState(false);
    const [searchInput, setSearchInput] = useState('');
    const [adding, setAdding] = useState(false);
    const [addError, setAddError] = useState<string | null>(null);
    // Les fournisseurs dont l'espace tient la clé : ce qui ouvre ou ferme le
    // choix de source. Jamais la clé elle-même, seulement le fait qu'elle existe.
    const [held, setHeld] = useState<Record<string, boolean>>({});

    // Le niveau profond de Météo : la ville consultée.
    const liveTarget = useLiveSegment('l1', selectedId);

    // La barre de source suit la ville, pas le relevé : elle survit ainsi à un
    // relevé en échec, seul chemin pour quitter une source devenue muette.
    const selected = locations.find((l) => l.id === selectedId) ?? null;

    // Ce que lisent les abonnements du direct, montés une fois pour toutes.
    const selectedRef = useRef<WeatherLocation | null>(null);
    selectedRef.current = selected;

    // L'ordre connu du serveur : un glisser qui ne change rien n'écrit rien.
    const persistedOrder = useRef<string>('');

    // Seule la dernière relecture demandée a le droit d'écrire : changer de ville
    // deux fois de suite ne doit pas afficher la première sous le nom de la seconde.
    const latestRequest = useRef(0);

    const loadReport = useCallback(async (id: string, opts?: { silent?: boolean }) => {
        const request = ++latestRequest.current;
        if (!opts?.silent) setLoadingReport(true);
        try {
            const res = await api.send('weather.get', { id });
            if (request !== latestRequest.current) return;
            setReport(res.report);
            setReportError(null);
        } catch (e) {
            if (request !== latestRequest.current) return;
            // Une relecture de fond qui échoue garde le relevé affiché, sauf clé
            // refusée : celui-là n'a plus le droit d'être montré.
            if (opts?.silent && !isKeyRefused(e)) return;
            setReport(null);
            setReportError(providerFailure(e)?.message ?? null);
        } finally {
            if (request === latestRequest.current) setLoadingReport(false);
        }
    }, []);

    /** La fiche vient d'écrire : sa liste fait foi, ici comme dans le magasin de la tuile. */
    const applyLocations = useCallback((next: WeatherLocation[]) => {
        setLocations(next);
        persistedOrder.current = next.map((l) => l.id).join(',');
        syncWeatherLocations(next);
    }, []);

    /**
     * Relire les villes, et le relevé seulement si la ville consultée a disparu
     * ou changé de source : un autre membre qui réordonne ne fait rien clignoter.
     */
    const reloadLocations = useCallback(async () => {
        try {
            const res = await api.send('weather.list', {});
            setLocations(res.locations);
            persistedOrder.current = res.locations.map((l) => l.id).join(',');
            const before = selectedRef.current;
            const after = res.locations.find((l) => l.id === before?.id) ?? res.locations[0] ?? null;
            if (!after) {
                setSelectedId(null);
                setReport(null);
                return;
            }
            if (after.id === before?.id && after.provider === before.provider) return;
            setSelectedId(after.id);
            await loadReport(after.id);
        } catch {
            // ignore : la prochaine trame du sujet repassera
        }
    }, [loadReport]);

    useEffect(() => {
        void reloadLocations().finally(() => setLoading(false));
        return onResourceChange('weather.list', () => void reloadLocations());
    }, [reloadLocations]);

    useEffect(() => {
        const load = async (): Promise<Record<string, boolean>> => {
            try {
                const res = await api.send('weather.keyList', {});
                const next = Object.fromEntries(res.providers.map((p) => [p.provider, p.hasKey]));
                setHeld(next);
                return next;
            } catch {
                // Sans réponse, seul le fournisseur libre reste proposé.
                return {};
            }
        };
        void load();
        // Une clé posée ou changée : le choix de source s'ouvre, et le relevé de la
        // ville consultée se refait si c'est cette clé qui le donne. Une clé
        // retirée passe par `weather.list` : le serveur a changé ses villes de source.
        return onResourceChange('weather.keyList', () => {
            void load().then((next) => {
                const current = selectedRef.current;
                if (current && next[current.provider] === true) void loadReport(current.id);
            });
        });
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
            // Une ville naît sur le fournisseur libre : sa source se change ensuite,
            // depuis la fiche, si l'espace en a une autre.
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
        } catch (err) {
            setAddError(providerFailure(err)?.message ?? 'La ville n’a pas pu être ajoutée.');
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
        // L'étoile bascule tout de suite, la réponse du serveur fait foi ensuite.
        setLocations((prev) => prev.map((l) => ({ ...l, isPrimary: l.id === id })));
        try {
            const res = await api.send('weather.setPrimary', { id });
            applyLocations(res.locations);
        } catch {
            void reloadLocations();
        }
    };

    const handleProviderChange = async (id: string, provider: WeatherProvider) => {
        try {
            const res = await api.send('weather.update', { id, provider });
            applyLocations(locations.map((l) => (l.id === res.location.id ? res.location : l)));
            if (selectedId === id) await loadReport(id);
        } catch {
            // ignore : le choix affiché suit la ville, il revient de lui-même
        }
    };

    const persistOrder = async () => {
        const order = locations.map((l) => l.id);
        if (order.join(',') === persistedOrder.current) return;
        persistedOrder.current = order.join(',');
        try {
            const res = await api.send('weather.reorder', { ids: order });
            applyLocations(res.locations);
        } catch {
            void reloadLocations();
        }
    };

    return (
        <div className={styles.container}>
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

                            {selected && (
                                <ProviderBar
                                    provider={selected.provider}
                                    held={held}
                                    onChange={(provider) => void handleProviderChange(selected.id, provider)}
                                />
                            )}
                        </motion.div>
                    ) : (
                        <div className={styles.empty}>
                            <p>Impossible de récupérer le rapport météo</p>
                            {reportError && <p>{reportError}</p>}
                            {selected && (
                                <ProviderBar
                                    provider={selected.provider}
                                    held={held}
                                    onChange={(provider) => void handleProviderChange(selected.id, provider)}
                                />
                            )}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
