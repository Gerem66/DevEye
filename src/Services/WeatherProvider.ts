import type {
    WeatherCondition,
    WeatherDay,
    WeatherFormat,
    WeatherHour,
    WeatherProvider,
    WeatherReport
} from 'deveye-types';

/**
 * Weather provider abstraction. Open-Meteo needs no API key and provides free
 * geocoding + forecast. Other providers (e.g. OpenWeatherMap) use a per-account
 * key supplied at call time. Network failures throw {@link WeatherError}.
 */

export class WeatherError extends Error {
    constructor(
        public readonly reason: 'geocoding_failed' | 'fetch_failed' | 'not_found',
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
        throw new WeatherError('fetch_failed', `Provider responded ${res.status}`);
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
            // Open-Meteo returns local-time hours (timezone=auto). Show the whole
            // current local day (from 00:00) onward so the client can highlight the
            // current hour and scroll it into view; cap the window at 32 hours.
            const todayLocal = new Date().toLocaleString('sv-SE', { timeZone: data.timezone ?? 'UTC' }).slice(0, 10); // "YYYY-MM-DD"
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
const OWM_ONECALL_URL = 'https://api.openweathermap.org/data/3.0/onecall';

/**
 * Map an OpenWeatherMap condition id to the closest WMO code, so the shared
 * `wmoIcon` mapping keeps working regardless of provider.
 * See https://openweathermap.org/weather-conditions
 */
function owmToWmo(id: number): number {
    if (id >= 200 && id < 300) return 95; // thunderstorm
    if (id >= 300 && id < 400) return 51; // drizzle
    if (id >= 500 && id < 600) {
        if (id >= 502) return 65; // heavy rain
        return 61; // rain
    }
    if (id >= 600 && id < 700) return 71; // snow
    if (id >= 700 && id < 800) return 45; // atmosphere (fog/mist/haze)
    if (id === 800) return 0; // clear
    if (id === 801) return 1; // few clouds
    if (id === 802) return 2; // scattered clouds
    if (id >= 803) return 3; // broken/overcast
    return 3;
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

interface OwmOneCall {
    timezone?: string;
    current?: {
        temp: number;
        feels_like?: number;
        humidity?: number;
        wind_speed?: number;
        weather: OwmWeatherEntry[];
    };
    hourly?: Array<{
        dt: number;
        temp: number;
        pop?: number;
        weather: OwmWeatherEntry[];
    }>;
    daily?: Array<{
        dt: number;
        temp: { min: number; max: number };
        pop?: number;
        weather: OwmWeatherEntry[];
    }>;
}

/** Format a unix timestamp as a local "YYYY-MM-DDTHH:00" string in `tz`. */
function localHourIso(unixSeconds: number, tz: string): string {
    // "sv-SE" gives "YYYY-MM-DD HH:mm:ss"; reshape to the ISO-ish form the client expects.
    const s = new Date(unixSeconds * 1000).toLocaleString('sv-SE', { timeZone: tz });
    return `${s.slice(0, 10)}T${s.slice(11, 13)}:00`;
}

/** Format a unix timestamp as a local "YYYY-MM-DD" date string in `tz`. */
function localDateIso(unixSeconds: number, tz: string): string {
    return new Date(unixSeconds * 1000).toLocaleString('sv-SE', { timeZone: tz }).slice(0, 10);
}

const openWeatherMapAdapter: WeatherProviderAdapter = {
    async geocode(query, apiKey) {
        if (!apiKey) throw new WeatherError('geocoding_failed', 'OpenWeatherMap requires an API key');
        const url = `${OWM_GEOCODE_URL}?q=${encodeURIComponent(query)}&limit=1&appid=${encodeURIComponent(apiKey)}`;
        const data = await getJson<OwmGeocode[]>(url);
        const hit = data[0];
        if (!hit) throw new WeatherError('not_found', `No location matched "${query}"`);
        const label = [hit.name, hit.state, hit.country].filter(Boolean).join(', ');
        return { label, latitude: hit.lat, longitude: hit.lon };
    },
    async fetchReport({ locationId, label, latitude, longitude, provider, apiKey }) {
        if (!apiKey) throw new WeatherError('fetch_failed', 'OpenWeatherMap requires an API key');
        const params = new URLSearchParams({
            lat: String(latitude),
            lon: String(longitude),
            units: 'metric',
            exclude: 'minutely,alerts',
            appid: apiKey
        });
        const data = await getJson<OwmOneCall>(`${OWM_ONECALL_URL}?${params.toString()}`);
        const tz = data.timezone ?? 'UTC';

        const current: WeatherCondition | null = data.current
            ? {
                  code: owmToWmo(data.current.weather[0]?.id ?? 800),
                  temperature: data.current.temp,
                  apparentTemperature: data.current.feels_like ?? null,
                  humidity: data.current.humidity ?? null,
                  windSpeed: data.current.wind_speed ?? null,
                  isDay: null
              }
            : null;

        const hourly: WeatherHour[] = [];
        if (data.hourly) {
            // Keep the current local day onward (matching Open-Meteo's behaviour),
            // capped at 32 hours.
            const todayLocal = new Date().toLocaleString('sv-SE', { timeZone: tz }).slice(0, 10);
            const fromToday = data.hourly.filter((h) => localDateIso(h.dt, tz) >= todayLocal);
            for (const h of fromToday.slice(0, 32)) {
                hourly.push({
                    time: localHourIso(h.dt, tz),
                    code: owmToWmo(h.weather[0]?.id ?? 800),
                    temperature: h.temp,
                    precipitationProbability: h.pop != null ? Math.round(h.pop * 100) : null
                });
            }
        }

        const daily: WeatherDay[] = [];
        if (data.daily) {
            for (const d of data.daily) {
                daily.push({
                    date: localDateIso(d.dt, tz),
                    code: owmToWmo(d.weather[0]?.id ?? 800),
                    tempMin: d.temp.min,
                    tempMax: d.temp.max,
                    precipitationProbability: d.pop != null ? Math.round(d.pop * 100) : null
                });
            }
        }

        return {
            locationId,
            label,
            fetchedAt: Math.floor(Date.now() / 1000),
            timezone: tz,
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
    return adapters[provider] ?? openMeteoAdapter;
}

/* ------------------------------ Report cache ------------------------------ */

/**
 * In-memory TTL cache for forecast reports. A report is the slow part of a home
 * load: every `weather.get` otherwise hits the provider live (≈300 ms–1 s), and
 * the client refreshes the primary city on connect *and* on every reconnect — so
 * without caching, reopening the app or a transient socket drop re-pays that cost
 * each time. Provider data only moves on a ~10-minute cadence (matching the
 * client's poll), so serving a cached report within that window is both correct
 * and dramatically faster, while a cold city still fetches live exactly once.
 *
 * The cache lives only in process memory and holds public forecast data keyed by
 * coordinates the server already stores in clear (sort/gating metadata, never
 * zero-knowledge payload). The API key is deliberately **excluded** from the key:
 * it authenticates the upstream call but never changes the weather, and must not
 * leak into cache-key material.
 */
const REPORT_TTL_MS = 10 * 60 * 1000;
/** Hard cap so a long-lived process can't grow the cache without bound. */
const REPORT_CACHE_MAX = 500;

interface CachedReport {
    report: WeatherReport;
    expires: number;
}

const reportCache = new Map<string, CachedReport>();

function reportCacheKey(input: FetchReportInput): string {
    // 4 decimals ≈ 11 m — far finer than any forecast grid, stable per stored row.
    return [input.provider, input.latitude.toFixed(4), input.longitude.toFixed(4), input.days, input.format].join('|');
}

/**
 * Fetch a forecast report, served from the TTL cache when fresh. Use this on the
 * read path (`weather.get`) instead of calling the adapter directly so repeated
 * loads of the same city are instant. Mutations (add/update) keep using the
 * adapter directly — they must always hit the provider.
 */
export async function fetchWeatherReport(input: FetchReportInput): Promise<WeatherReport> {
    const key = reportCacheKey(input);
    const now = Date.now();

    const hit = reportCache.get(key);
    if (hit && hit.expires > now) return hit.report;
    if (hit) reportCache.delete(key); // expired — drop before refetching

    const report = await getWeatherAdapter(input.provider).fetchReport(input);

    // Evict the oldest entry once at capacity (Map preserves insertion order).
    if (reportCache.size >= REPORT_CACHE_MAX) {
        const oldest = reportCache.keys().next().value;
        if (oldest !== undefined) reportCache.delete(oldest);
    }
    reportCache.set(key, { report, expires: now + REPORT_TTL_MS });
    return report;
}
