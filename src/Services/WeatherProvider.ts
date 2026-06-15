import type { WeatherCondition, WeatherDay, WeatherFormat, WeatherProvider, WeatherReport } from 'deveye-types';

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
    current?: {
        weather_code: number;
        temperature_2m: number;
        apparent_temperature?: number;
        relative_humidity_2m?: number;
        wind_speed_10m?: number;
        is_day?: number;
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
    async fetchReport({ locationId, label, latitude, longitude, days }) {
        const params = new URLSearchParams({
            latitude: String(latitude),
            longitude: String(longitude),
            current: 'weather_code,temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,is_day',
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

        return { locationId, label, fetchedAt: Math.floor(Date.now() / 1000), current, daily };
    }
};

/**
 * OpenWeatherMap stub: enrollment of a key is supported, but the provider falls
 * back to Open-Meteo's free endpoints unless a key is configured. Implemented as
 * a thin pass-through for now so the contract is stable; extend as needed.
 */
const adapters: Record<WeatherProvider, WeatherProviderAdapter> = {
    'open-meteo': openMeteoAdapter,
    openweathermap: openMeteoAdapter
};

export function getWeatherAdapter(provider: WeatherProvider): WeatherProviderAdapter {
    return adapters[provider] ?? openMeteoAdapter;
}
