import { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { ws } from '@/api/ws';
import type { WeatherLocation, WeatherReport } from 'deveye-types';
import type { FeatureProps } from '../types';
import styles from './Weather.module.css';

/** WMO weather codes → emoji */
const WMO_ICONS: Record<number, string> = {
    0: '☀️',
    1: '🌤️',
    2: '⛅',
    3: '☁️',
    45: '🌫️',
    48: '🌫️',
    51: '🌦️',
    53: '🌦️',
    55: '🌧️',
    61: '🌧️',
    63: '🌧️',
    65: '🌧️',
    71: '🌨️',
    73: '🌨️',
    75: '❄️',
    80: '🌦️',
    81: '🌧️',
    82: '🌧️',
    95: '⛈️',
    96: '⛈️',
    99: '⛈️'
};

function wmoIcon(code: number) {
    return WMO_ICONS[code] ?? '🌡️';
}

export function WeatherWidget() {
    const [report, setReport] = useState<WeatherReport | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        ws.send('weather.list', {})
            .then(async (res) => {
                const first = res.locations[0];
                if (!first) return;
                const r = await ws.send('weather.get', { id: first.id });
                setReport(r.report);
            })
            .catch(() => {})
            .finally(() => setLoading(false));
    }, []);

    if (loading) return <div className={styles.widgetLoading}>Chargement...</div>;
    if (!report?.current)
        return (
            <div className={styles.widgetEmpty}>
                <span>🌡️</span>
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

export default function Weather({ user: _user, workspace: _ws }: FeatureProps) {
    const [locations, setLocations] = useState<WeatherLocation[]>([]);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [report, setReport] = useState<WeatherReport | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadingReport, setLoadingReport] = useState(false);
    const [searchInput, setSearchInput] = useState('');
    const [adding, setAdding] = useState(false);

    const fetchLocations = useCallback(async () => {
        try {
            const res = await ws.send('weather.list', {});
            setLocations(res.locations);
            if (res.locations.length > 0 && selectedId === null) {
                const first = res.locations[0];
                setSelectedId(first.id);
                await fetchReport(first.id);
            }
        } catch {
            // ignore
        } finally {
            setLoading(false);
        }
    }, [selectedId]);

    const fetchReport = async (id: string) => {
        setLoadingReport(true);
        try {
            const res = await ws.send('weather.get', { id });
            setReport(res.report);
        } catch {
            setReport(null);
        } finally {
            setLoadingReport(false);
        }
    };

    useEffect(() => {
        void fetchLocations();
    }, []);

    const handleSelectLocation = async (id: string) => {
        setSelectedId(id);
        await fetchReport(id);
    };

    const handleAdd = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!searchInput.trim()) return;
        setAdding(true);
        try {
            const res = await ws.send('weather.add', {
                query: searchInput.trim(),
                format: 'current',
                days: 7,
                provider: 'open-meteo'
            });
            setLocations((prev) => [...prev, res.location]);
            setSearchInput('');
            setSelectedId(res.location.id);
            await fetchReport(res.location.id);
        } catch {
            // ignore
        } finally {
            setAdding(false);
        }
    };

    const handleRemove = async (id: string) => {
        try {
            await ws.send('weather.remove', { id });
            setLocations((prev) => prev.filter((l) => l.id !== id));
            if (selectedId === id) {
                const remaining = locations.filter((l) => l.id !== id);
                const next = remaining[0] ?? null;
                setSelectedId(next?.id ?? null);
                setReport(null);
                if (next) await fetchReport(next.id);
            }
        } catch {
            // ignore
        }
    };

    return (
        <div className={styles.container}>
            <h2 className={styles.title}>Météo</h2>

            <form className={styles.searchForm} onSubmit={handleAdd}>
                <input
                    type='text'
                    className={styles.searchInput}
                    placeholder='Ajouter une ville…'
                    value={searchInput}
                    onChange={(e) => setSearchInput(e.target.value)}
                />
                <button type='submit' className={styles.searchBtn} disabled={adding}>
                    {adding ? <span className={styles.spinner} /> : <span className='icon-plus' />}
                </button>
            </form>

            {loading ? (
                <div className={styles.loader}>Chargement...</div>
            ) : locations.length === 0 ? (
                <div className={styles.empty}>
                    <span className={styles.emptyIcon}>🌡️</span>
                    <p>Ajoutez une ville pour voir la météo</p>
                </div>
            ) : (
                <div className={styles.weatherContent}>
                    {/* Location tabs */}
                    <div className={styles.locationTabs}>
                        {locations.map((loc) => (
                            <div key={loc.id} className={styles.locationTabWrapper}>
                                <button
                                    className={`${styles.locationTab} ${loc.id === selectedId ? styles.activeTab : ''}`}
                                    onClick={() => handleSelectLocation(loc.id)}
                                >
                                    {loc.label}
                                </button>
                                <button
                                    className={styles.removeTabBtn}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        void handleRemove(loc.id);
                                    }}
                                    aria-label='Supprimer'
                                >
                                    ×
                                </button>
                            </div>
                        ))}
                    </div>

                    {/* Report */}
                    {loadingReport ? (
                        <div className={styles.loader}>Chargement du rapport…</div>
                    ) : report?.current ? (
                        <motion.div
                            key={report.locationId}
                            className={styles.currentWeather}
                            initial={{ opacity: 0, y: 20 }}
                            animate={{ opacity: 1, y: 0 }}
                        >
                            <div className={styles.currentMain}>
                                <span className={styles.bigIcon}>{wmoIcon(report.current.code)}</span>
                                <div className={styles.tempBlock}>
                                    <span className={styles.bigTemp}>{Math.round(report.current.temperature)}°C</span>
                                    <span className={styles.locationLarge}>{report.label}</span>
                                </div>
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

                            {report.daily.length > 0 && (
                                <div className={styles.forecastSection}>
                                    <h3 className={styles.forecastTitle}>Prévisions</h3>
                                    <div className={styles.forecastGrid}>
                                        {report.daily.map((day, i) => (
                                            <motion.div
                                                key={day.date}
                                                className={styles.forecastCard}
                                                initial={{ opacity: 0, y: 20 }}
                                                animate={{ opacity: 1, y: 0 }}
                                                transition={{ delay: i * 0.07 }}
                                            >
                                                <span className={styles.forecastDay}>
                                                    {new Date(day.date).toLocaleDateString('fr-FR', {
                                                        weekday: 'short'
                                                    })}
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
                        </motion.div>
                    ) : (
                        <div className={styles.empty}>
                            <p>Impossible de récupérer le rapport météo</p>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
