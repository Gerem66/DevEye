import type {
    WeatherCondition,
    WeatherDay,
    WeatherFormat,
    WeatherHour,
    WeatherProvider,
    WeatherReport
} from '../contracts/domain';

/**
 * Les fournisseurs météo derrière une même interface. Open-Meteo est libre et
 * sans clé ; les autres reçoivent la clé de l'espace à chaque appel. Tout échec
 * sort en {@link WeatherError}, dont la raison décide du message et du sort du
 * relevé côté client.
 */

export class WeatherError extends Error {
    constructor(
        public readonly reason: 'fetch_failed' | 'not_found' | 'unauthorized',
        message: string
    ) {
        super(message);
        this.name = 'WeatherError';
    }
}

export interface GeocodeResult {
    label: string;
    latitude: number;
    longitude: number;
}

export interface FetchReportInput {
    locationId: string;
    label: string;
    latitude: number;
    longitude: number;
    format: WeatherFormat;
    days: number;
    provider: WeatherProvider;
    apiKey?: string | null;
}

export interface WeatherProviderAdapter {
    geocode(query: string, apiKey?: string | null): Promise<GeocodeResult>;
    fetchReport(input: FetchReportInput): Promise<WeatherReport>;
}

const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

interface OpenMeteoGeocode {
    results?: Array<{
        name: string;
        latitude: number;
        longitude: number;
        country?: string;
        admin1?: string;
    }>;
}

interface OpenMeteoForecast {
    timezone?: string;
    current?: {
        weather_code: number;
        temperature_2m: number;
        apparent_temperature?: number;
        relative_humidity_2m?: number;
        wind_speed_10m?: number;
        is_day?: number;
    };
    hourly?: {
        time: string[];
        weather_code: number[];
        temperature_2m: number[];
        precipitation_probability?: number[];
    };
    daily?: {
        time: string[];
        weather_code: number[];
        temperature_2m_min: number[];
        temperature_2m_max: number[];
        precipitation_probability_max?: number[];
    };
}

async function getJson<T>(url: string): Promise<T> {
    let res: Response;
    try {
        res = await fetch(url, { headers: { accept: 'application/json' } });
    } catch (e) {
        throw new WeatherError('fetch_failed', `Network error: ${(e as Error).message}`);
    }
    if (!res.ok) {
        // 401/403 : c'est la clé, pas le réseau.
        const reason = res.status === 401 || res.status === 403 ? 'unauthorized' : 'fetch_failed';
        throw new WeatherError(reason, `Provider responded ${res.status}`);
    }
    return (await res.json()) as T;
}

const openMeteoAdapter: WeatherProviderAdapter = {
    async geocode(query) {
        const url = `${GEOCODE_URL}?name=${encodeURIComponent(query)}&count=1&language=en&format=json`;
        const data = await getJson<OpenMeteoGeocode>(url);
        const hit = data.results?.[0];
        if (!hit) throw new WeatherError('not_found', `No location matched "${query}"`);
        const label = [hit.name, hit.admin1, hit.country].filter(Boolean).join(', ');
        return { label, latitude: hit.latitude, longitude: hit.longitude };
    },
    async fetchReport({ locationId, label, latitude, longitude, days, provider }) {
        const params = new URLSearchParams({
            latitude: String(latitude),
            longitude: String(longitude),
            current: 'weather_code,temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,is_day',
            hourly: 'weather_code,temperature_2m,precipitation_probability',
            daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
            forecast_days: String(Math.min(Math.max(days, 1), 16)),
            timezone: 'auto'
        });
        const data = await getJson<OpenMeteoForecast>(`${FORECAST_URL}?${params.toString()}`);

        const current: WeatherCondition | null = data.current
            ? {
                  code: data.current.weather_code,
                  temperature: data.current.temperature_2m,
                  apparentTemperature: data.current.apparent_temperature ?? null,
                  humidity: data.current.relative_humidity_2m ?? null,
                  windSpeed: data.current.wind_speed_10m ?? null,
                  isDay: data.current.is_day === undefined ? null : data.current.is_day === 1
              }
            : null;

        const hourly: WeatherHour[] = [];
        if (data.hourly) {
            // Les heures arrivent en heure locale (timezone=auto). On sert le jour
            // local courant depuis 00:00, pour que le client y repère « maintenant »,
            // sur 32 créneaux au plus.
            const todayLocal = new Date().toLocaleString('sv-SE', { timeZone: data.timezone ?? 'UTC' }).slice(0, 10);
            const startIdx = data.hourly.time.findIndex((t) => t.slice(0, 10) >= todayLocal);
            const from = startIdx === -1 ? 0 : startIdx;
            for (let i = from; i < Math.min(from + 32, data.hourly.time.length); i++) {
                hourly.push({
                    time: data.hourly.time[i],
                    code: data.hourly.weather_code[i],
                    temperature: data.hourly.temperature_2m[i],
                    precipitationProbability: data.hourly.precipitation_probability?.[i] ?? null
                });
            }
        }

        const daily: WeatherDay[] = [];
        if (data.daily) {
            for (let i = 0; i < data.daily.time.length; i++) {
                daily.push({
                    date: data.daily.time[i],
                    code: data.daily.weather_code[i],
                    tempMin: data.daily.temperature_2m_min[i],
                    tempMax: data.daily.temperature_2m_max[i],
                    precipitationProbability: data.daily.precipitation_probability_max?.[i] ?? null
                });
            }
        }

        return {
            locationId,
            label,
            fetchedAt: Math.floor(Date.now() / 1000),
            timezone: data.timezone ?? 'UTC',
            provider,
            current,
            hourly,
            daily
        };
    }
};

/* ----------------------------- OpenWeatherMap ----------------------------- */

const OWM_GEOCODE_URL = 'https://api.openweathermap.org/geo/1.0/direct';
/**
 * Les points d'entrée 2.5, pas One Call 3.0 : ce dernier exige un abonnement à
 * part et refuse une clé gratuite, qui n'atteint que ces deux-là.
 */
const OWM_WEATHER_URL = 'https://api.openweathermap.org/data/2.5/weather';
const OWM_FORECAST_URL = 'https://api.openweathermap.org/data/2.5/forecast';

/**
 * Le code WMO le plus proche d'un identifiant de condition OpenWeatherMap : les
 * icônes (`wmoIcon`) restent ainsi les mêmes d'un fournisseur à l'autre.
 * Voir https://openweathermap.org/weather-conditions
 */
function owmToWmo(id: number): number {
    if (id >= 200 && id < 300) return 95; // orage
    if (id >= 300 && id < 400) return 51; // bruine
    if (id >= 500 && id < 600) return id >= 502 ? 65 : 61; // pluie, forte à partir de 502
    if (id >= 600 && id < 700) return 71; // neige
    if (id >= 700 && id < 800) return 45; // brume, brouillard
    if (id === 800) return 0; // dégagé
    if (id === 801) return 1; // peu nuageux
    if (id === 802) return 2; // nuages épars
    return 3; // couvert
}

interface OwmGeocode {
    name: string;
    lat: number;
    lon: number;
    country?: string;
    state?: string;
}

interface OwmWeatherEntry {
    id: number;
}

interface OwmCurrent {
    dt: number;
    /** Le décalage à UTC, en secondes : le seul fuseau que 2.5 donne. */
    timezone?: number;
    main: { temp: number; feels_like?: number; humidity?: number };
    wind?: { speed?: number };
    weather: OwmWeatherEntry[];
    sys?: { sunrise?: number; sunset?: number };
}

interface OwmForecastEntry {
    dt: number;
    main: { temp: number; temp_min: number; temp_max: number };
    pop?: number;
    weather: OwmWeatherEntry[];
}

interface OwmForecast {
    list: OwmForecastEntry[];
    city?: { timezone?: number };
}

/** L'horloge murale d'un instant à un décalage fixe : décaler, puis lire en UTC. */
function localIso(unixSeconds: number, offsetSeconds: number): string {
    return new Date((unixSeconds + offsetSeconds) * 1000).toISOString();
}

function localDateIso(unixSeconds: number, offsetSeconds: number): string {
    return localIso(unixSeconds, offsetSeconds).slice(0, 10);
}

function localHourIso(unixSeconds: number, offsetSeconds: number): string {
    const s = localIso(unixSeconds, offsetSeconds);
    return `${s.slice(0, 10)}T${s.slice(11, 13)}:00`;
}

/**
 * Le relevé porte un fuseau, 2.5 ne donne qu'un décalage : « +02:00 » est un
 * identifiant de fuseau qu'`Intl` accepte, et c'est avec lui que le client formate.
 */
function offsetTimeZone(offsetSeconds: number): string {
    const minutes = Math.abs(Math.round(offsetSeconds / 60));
    const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
    const mm = String(minutes % 60).padStart(2, '0');
    return `${offsetSeconds < 0 ? '-' : '+'}${hh}:${mm}`;
}

/** OpenWeatherMap donne le vent en m/s, le relevé est en km/h. */
function toKmh(metersPerSecond: number): number {
    return Math.round(metersPerSecond * 3.6 * 10) / 10;
}

const openWeatherMapAdapter: WeatherProviderAdapter = {
    async geocode(query, apiKey) {
        if (!apiKey) throw new WeatherError('unauthorized', 'OpenWeatherMap requires an API key');
        const url = `${OWM_GEOCODE_URL}?q=${encodeURIComponent(query)}&limit=1&appid=${encodeURIComponent(apiKey)}`;
        const data = await getJson<OwmGeocode[]>(url);
        const hit = data[0];
        if (!hit) throw new WeatherError('not_found', `No location matched "${query}"`);
        const label = [hit.name, hit.state, hit.country].filter(Boolean).join(', ');
        return { label, latitude: hit.lat, longitude: hit.lon };
    },
    async fetchReport({ locationId, label, latitude, longitude, days, provider, apiKey }) {
        if (!apiKey) throw new WeatherError('unauthorized', 'OpenWeatherMap requires an API key');
        const params = new URLSearchParams({
            lat: String(latitude),
            lon: String(longitude),
            units: 'metric',
            appid: apiKey
        });
        const [now, forecast] = await Promise.all([
            getJson<OwmCurrent>(`${OWM_WEATHER_URL}?${params.toString()}`),
            getJson<OwmForecast>(`${OWM_FORECAST_URL}?${params.toString()}`)
        ]);
        const offset = now.timezone ?? forecast.city?.timezone ?? 0;

        const sunrise = now.sys?.sunrise;
        const sunset = now.sys?.sunset;
        const current: WeatherCondition = {
            code: owmToWmo(now.weather[0]?.id ?? 800),
            temperature: now.main.temp,
            apparentTemperature: now.main.feels_like ?? null,
            humidity: now.main.humidity ?? null,
            windSpeed: now.wind?.speed != null ? toKmh(now.wind.speed) : null,
            isDay: sunrise != null && sunset != null ? now.dt >= sunrise && now.dt < sunset : null
        };

        // 2.5 avance par pas de trois heures sur cinq jours. Même fenêtre
        // qu'Open-Meteo : le jour local courant et la suite, sur 32 créneaux au plus.
        const todayLocal = localDateIso(Math.floor(Date.now() / 1000), offset);
        const hourly: WeatherHour[] = [];
        for (const entry of forecast.list) {
            if (localDateIso(entry.dt, offset) < todayLocal) continue;
            if (hourly.length >= 32) break;
            hourly.push({
                time: localHourIso(entry.dt, offset),
                code: owmToWmo(entry.weather[0]?.id ?? 800),
                temperature: entry.main.temp,
                precipitationProbability: entry.pop != null ? Math.round(entry.pop * 100) : null
            });
        }

        // Une journée se recompose de ses créneaux : extrêmes, pire risque de
        // pluie, et le code du créneau le plus proche de midi pour la représenter.
        interface DayAccumulator {
            code: number;
            min: number;
            max: number;
            pop: number;
            hour: number;
        }
        const byDate = new Map<string, DayAccumulator>();
        for (const entry of forecast.list) {
            const date = localDateIso(entry.dt, offset);
            const hour = Number(localHourIso(entry.dt, offset).slice(11, 13));
            const code = entry.weather[0]?.id ?? 800;
            const slot = byDate.get(date);
            if (!slot) {
                byDate.set(date, {
                    code,
                    min: entry.main.temp_min,
                    max: entry.main.temp_max,
                    pop: entry.pop ?? 0,
                    hour
                });
                continue;
            }
            slot.min = Math.min(slot.min, entry.main.temp_min);
            slot.max = Math.max(slot.max, entry.main.temp_max);
            slot.pop = Math.max(slot.pop, entry.pop ?? 0);
            if (Math.abs(hour - 12) < Math.abs(slot.hour - 12)) {
                slot.code = code;
                slot.hour = hour;
            }
        }
        const daily: WeatherDay[] = [...byDate.entries()].slice(0, days).map(([date, slot]) => ({
            date,
            code: owmToWmo(slot.code),
            tempMin: slot.min,
            tempMax: slot.max,
            precipitationProbability: Math.round(slot.pop * 100)
        }));

        return {
            locationId,
            label,
            fetchedAt: Math.floor(Date.now() / 1000),
            timezone: offsetTimeZone(offset),
            provider,
            current,
            hourly,
            daily
        };
    }
};

const adapters: Record<WeatherProvider, WeatherProviderAdapter> = {
    'open-meteo': openMeteoAdapter,
    openweathermap: openWeatherMapAdapter
};

export function getWeatherAdapter(provider: WeatherProvider): WeatherProviderAdapter {
    return adapters[provider];
}

/* --------------------------------- Le cache -------------------------------- */

/**
 * Les relevés gardés dix minutes en mémoire : le client relit la ville
 * principale à chaque connexion, et les fournisseurs ne bougent guère plus
 * vite. La clé d'API n'entre pas dans la clé de cache, elle authentifie l'appel
 * sans changer la météo : c'est `forgetProviderReports` qui périme les relevés
 * quand elle change.
 */
const REPORT_TTL_MS = 10 * 60 * 1000;
/** Le plafond d'entrées, pour qu'un processus qui dure ne grossisse pas sans fin. */
const REPORT_CACHE_MAX = 500;

interface CachedReport {
    report: WeatherReport;
    expires: number;
}

const reportCache = new Map<string, CachedReport>();
/** Combien de fois la clé d'un fournisseur a changé depuis le démarrage. */
const keyGeneration = new Map<WeatherProvider, number>();

function reportCacheKey(input: FetchReportInput): string {
    // Quatre décimales, soit une dizaine de mètres : plus fin que toute grille de prévision.
    return [input.provider, input.latitude.toFixed(4), input.longitude.toFixed(4), input.days, input.format].join('|');
}

/**
 * Oublier les relevés d'un fournisseur dont la clé vient de changer : sans cela,
 * une clé retirée continuerait dix minutes à servir ce qu'elle seule permettait
 * d'obtenir. La génération avance aussi, pour qu'un appel parti avec l'ancienne
 * clé ne vienne pas repeupler le cache à son retour.
 *
 * La portée est le processus, comme le cache : un autre espace y perd ses
 * entrées et les reprend à son prochain appel.
 */
export function forgetProviderReports(provider: WeatherProvider): void {
    keyGeneration.set(provider, (keyGeneration.get(provider) ?? 0) + 1);
    for (const key of reportCache.keys()) {
        if (key.startsWith(`${provider}|`)) reportCache.delete(key);
    }
}

/** La lecture (`weather.get`) : le cache tant qu'il est frais, le fournisseur sinon. */
export async function fetchWeatherReport(input: FetchReportInput): Promise<WeatherReport> {
    const key = reportCacheKey(input);
    const now = Date.now();

    const hit = reportCache.get(key);
    if (hit && hit.expires > now) return hit.report;
    if (hit) reportCache.delete(key);

    const generation = keyGeneration.get(input.provider) ?? 0;
    const report = await getWeatherAdapter(input.provider).fetchReport(input);
    if ((keyGeneration.get(input.provider) ?? 0) !== generation) return report;

    // `Map` garde l'ordre d'insertion : la première clé est la plus ancienne.
    if (reportCache.size >= REPORT_CACHE_MAX) {
        const oldest = reportCache.keys().next().value;
        if (oldest !== undefined) reportCache.delete(oldest);
    }
    reportCache.set(key, { report, expires: now + REPORT_TTL_MS });
    return report;
}
