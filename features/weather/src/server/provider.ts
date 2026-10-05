import { env } from './env';
import type {
    WeatherCondition,
    WeatherDay,
    WeatherFormat,
    WeatherHour,
    WeatherProvider,
    WeatherReport
} from '../contracts/domain';

/**
 * Les fournisseurs météo derrière une même interface. Open-Meteo prend la clé de
 * l'instance quand elle en a une ; les autres reçoivent la clé de l'espace à
 * chaque appel. Tout échec sort en {@link WeatherError}, dont la raison décide
 * du message et du sort du relevé côté client.
 */

export class WeatherError extends Error {
    constructor(
        /** `misconfigured` : la clé de l'instance est refusée, rien que l'espace puisse corriger. */
        public readonly reason: 'fetch_failed' | 'not_found' | 'unauthorized' | 'rate_limited' | 'misconfigured',
        message: string,
        /** Le délai avant de réessayer, quand il est connu. */
        public readonly retryAfterMs?: number
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

export interface GeocodeInput {
    workspaceId: number;
    provider: WeatherProvider;
    query: string;
    apiKey?: string | null;
}

export interface FetchReportInput {
    workspaceId: number;
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

/**
 * Une adresse d'Open-Meteo. Avec la clé de l'instance, l'hôte `customer-` et
 * `apikey` : c'est ce que couvre l'abonnement commercial ; sans elle, le palier
 * gratuit, réservé au non commercial.
 */
function openMeteoUrl(host: 'api' | 'geocoding-api', path: string, params: URLSearchParams): string {
    const key = env.OPEN_METEO_API_KEY;
    if (key) params.set('apikey', key);
    return `https://${key ? 'customer-' : ''}${host}.open-meteo.com${path}?${params.toString()}`;
}

async function openMeteoJson<T>(url: string): Promise<T> {
    try {
        return await getJson<T>(url);
    } catch (e) {
        if (e instanceof WeatherError && e.reason === 'unauthorized') {
            throw new WeatherError('misconfigured', 'Open-Meteo refuse OPEN_METEO_API_KEY');
        }
        throw e;
    }
}

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

/** Sans lui, un fournisseur muet retient le handler aussi longtemps qu'il veut. */
const PROVIDER_TIMEOUT_MS = 10_000;

/** L'en-tête `Retry-After` du fournisseur, en millisecondes, s'il en donne un. */
function retryAfterMs(res: Response): number | undefined {
    const seconds = Number(res.headers.get('retry-after'));
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

async function getJson<T>(url: string): Promise<T> {
    let res: Response;
    try {
        res = await fetch(url, {
            headers: { accept: 'application/json' },
            signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS)
        });
    } catch (e) {
        const message =
            (e as Error).name === 'TimeoutError'
                ? `Provider timed out after ${PROVIDER_TIMEOUT_MS}ms`
                : `Network error: ${(e as Error).message}`;
        throw new WeatherError('fetch_failed', message);
    }
    if (!res.ok) {
        // 401/403 : c'est la clé, pas le réseau. 429 : le quota, que le palier
        // gratuit compte par adresse IP, donc pour toute l'instance à la fois.
        const reason =
            res.status === 401 || res.status === 403
                ? 'unauthorized'
                : res.status === 429
                  ? 'rate_limited'
                  : 'fetch_failed';
        throw new WeatherError(reason, `Provider responded ${res.status}`, retryAfterMs(res));
    }
    try {
        return (await res.json()) as T;
    } catch (e) {
        throw new WeatherError('fetch_failed', `Malformed provider response: ${(e as Error).message}`);
    }
}

const openMeteoAdapter: WeatherProviderAdapter = {
    async geocode(query) {
        const params = new URLSearchParams({ name: query, count: '1', language: 'en', format: 'json' });
        const data = await openMeteoJson<OpenMeteoGeocode>(openMeteoUrl('geocoding-api', '/v1/search', params));
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
        const data = await openMeteoJson<OpenMeteoForecast>(openMeteoUrl('api', '/v1/forecast', params));

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

function adapterFor(provider: WeatherProvider): WeatherProviderAdapter {
    return adapters[provider];
}

/* ------------------------- Le budget d'un espace -------------------------- */

/**
 * Le seau à jetons qui plafonne les appels sortants d'un espace. Le quota du
 * palier gratuit se compte par adresse IP, donc une seule enveloppe pour toute
 * l'instance : sans ce frein, un espace qui boucle sur l'ajout de villes
 * l'épuise pour tous les autres.
 *
 * C'est une coupure d'emballement, pas un partage équitable : le seau est assez
 * large pour qu'un usage réel ne le sente jamais. En régime établi, une ville
 * suivie coûte six appels par heure (le cache tient dix minutes), et l'ajout
 * d'une ville un appel.
 */
const BUDGET_CAPACITY = 240;
/** Quatre jetons par minute, de quoi suivre quarante villes sans jamais buter. */
const BUDGET_REFILL_MS = 15_000;
/** Au-delà, les seaux revenus à plein s'oublient : ils ne valent plus qu'un absent. */
const BUDGET_MAX_BUCKETS = 2000;

interface Budget {
    tokens: number;
    updated: number;
}

const budgets = new Map<string, Budget>();

/**
 * Prend un jeton, ou lève. N'est appelé que pour un appel qui part vraiment :
 * un relevé servi par le cache ou par une requête déjà en vol ne coûte rien.
 */
function spendBudget(workspaceId: number, provider: WeatherProvider): void {
    const key = `${workspaceId}|${provider}`;
    const now = Date.now();
    const bucket = budgets.get(key) ?? { tokens: BUDGET_CAPACITY, updated: now };
    bucket.tokens = Math.min(BUDGET_CAPACITY, bucket.tokens + (now - bucket.updated) / BUDGET_REFILL_MS);
    bucket.updated = now;
    if (bucket.tokens < 1) {
        budgets.set(key, bucket);
        throw new WeatherError(
            'rate_limited',
            'Workspace call budget exhausted',
            Math.ceil((1 - bucket.tokens) * BUDGET_REFILL_MS)
        );
    }
    bucket.tokens -= 1;
    if (budgets.size >= BUDGET_MAX_BUCKETS) {
        for (const [k, b] of budgets) if (b.tokens >= BUDGET_CAPACITY) budgets.delete(k);
    }
    budgets.set(key, bucket);
}

/* --------------------------------- Le cache -------------------------------- */

/**
 * Les relevés gardés dix minutes en mémoire : le client relit la ville
 * principale à chaque connexion, et les fournisseurs ne bougent guère plus
 * vite. La clé d'API n'entre pas dans la clé de cache, elle authentifie l'appel
 * sans changer la météo : c'est `forgetProviderCaches` qui périme les entrées
 * quand elle change.
 */
const REPORT_TTL_MS = 10 * 60 * 1000;
/** Les lieux géocodés bougent bien moins vite que le temps qu'il y fait. */
const GEOCODE_TTL_MS = 60 * 60 * 1000;
/**
 * L'échec se garde aussi, beaucoup plus court : sans cela, un fournisseur qui
 * refuse est rappelé par chaque lecture, ce qui ne fait que prolonger son refus.
 */
const FAILURE_TTL_MS = 60 * 1000;
/** Le plafond d'entrées, pour qu'un processus qui dure ne grossisse pas sans fin. */
const CACHE_MAX = 500;
/** Après un 429, plus rien ne part vers ce fournisseur pendant ce délai. */
const COOLDOWN_MS = 60 * 1000;

type CacheEntry<T> = { expires: number } & ({ ok: true; value: T } | { ok: false; error: WeatherError });

const reportCache = new Map<string, CacheEntry<WeatherReport>>();
const geocodeCache = new Map<string, CacheEntry<GeocodeResult>>();
const reportsInFlight = new Map<string, Promise<WeatherReport>>();
const geocodesInFlight = new Map<string, Promise<GeocodeResult>>();
/** Combien de fois la clé d'un fournisseur a changé depuis le démarrage. */
const keyGeneration = new Map<WeatherProvider, number>();
const cooldownUntil = new Map<WeatherProvider, number>();

function reportCacheKey(input: FetchReportInput): string {
    // Quatre décimales, soit une dizaine de mètres : plus fin que toute grille de prévision.
    return [input.provider, input.latitude.toFixed(4), input.longitude.toFixed(4), input.days, input.format].join('|');
}

/** L'entrée encore fraîche, ou `null`. Une entrée périmée s'efface au passage. */
function readCache<T>(cache: Map<string, CacheEntry<T>>, key: string): CacheEntry<T> | null {
    const hit = cache.get(key);
    if (!hit) return null;
    if (hit.expires > Date.now()) return hit;
    cache.delete(key);
    return null;
}

function writeCache<T>(cache: Map<string, CacheEntry<T>>, key: string, entry: CacheEntry<T>): void {
    // `Map` garde l'ordre d'insertion : la première clé est la plus ancienne.
    if (!cache.has(key) && cache.size >= CACHE_MAX) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, entry);
}

function forgetPrefix(cache: Map<string, unknown>, prefix: string): void {
    for (const key of cache.keys()) if (key.startsWith(prefix)) cache.delete(key);
}

/**
 * Oublier ce qu'un fournisseur dont la clé vient de changer avait servi : sans
 * cela, une clé retirée continuerait dix minutes à donner ce qu'elle seule
 * permettait d'obtenir. La génération avance aussi, pour qu'un appel parti avec
 * l'ancienne clé ne vienne pas repeupler le cache à son retour.
 *
 * La portée est le processus, comme le cache : un autre espace y perd ses
 * entrées et les reprend à son prochain appel. Le recul après un 429, lui, ne
 * se lève pas : changer de clé ne rend pas le quota.
 */
export function forgetProviderCaches(provider: WeatherProvider): void {
    keyGeneration.set(provider, (keyGeneration.get(provider) ?? 0) + 1);
    forgetPrefix(reportCache, `${provider}|`);
    forgetPrefix(geocodeCache, `${provider}|`);
}

/**
 * Le cache, puis la requête unique, puis le budget. Une réponse fraîche, bonne
 * ou mauvaise, ne dépense rien ; une requête déjà en vol sur la même clé
 * s'attend plutôt que de se doubler, ce qui compte surtout au redémarrage, où
 * toutes les sessions relisent d'un coup un cache vide.
 */
async function throughCache<T>(opts: {
    cache: Map<string, CacheEntry<T>>;
    running: Map<string, Promise<T>>;
    key: string;
    ttl: number;
    provider: WeatherProvider;
    workspaceId: number;
    call: () => Promise<T>;
}): Promise<T> {
    const hit = readCache(opts.cache, opts.key);
    if (hit) {
        if (hit.ok) return hit.value;
        throw hit.error;
    }
    const joined = opts.running.get(opts.key);
    if (joined) return joined;

    const cooldown = (cooldownUntil.get(opts.provider) ?? 0) - Date.now();
    if (cooldown > 0) throw new WeatherError('rate_limited', 'Provider is cooling down', cooldown);
    spendBudget(opts.workspaceId, opts.provider);

    // La génération capture l'état de la clé au départ : un appel parti avec
    // l'ancienne ne repeuple pas le cache à son retour.
    const generation = keyGeneration.get(opts.provider) ?? 0;
    const current = (): boolean => (keyGeneration.get(opts.provider) ?? 0) === generation;
    const started = (async () => {
        try {
            const value = await opts.call();
            if (current()) writeCache(opts.cache, opts.key, { ok: true, value, expires: Date.now() + opts.ttl });
            return value;
        } catch (e) {
            if (e instanceof WeatherError) {
                // Le quota est du fournisseur, pas de cette clé de cache : c'est
                // tout ce qui part vers lui qui s'arrête, le temps du recul.
                if (e.reason === 'rate_limited') {
                    cooldownUntil.set(opts.provider, Date.now() + Math.max(e.retryAfterMs ?? 0, COOLDOWN_MS));
                } else if (current()) {
                    writeCache(opts.cache, opts.key, { ok: false, error: e, expires: Date.now() + FAILURE_TTL_MS });
                }
            }
            throw e;
        }
    })();
    opts.running.set(opts.key, started);
    return started.finally(() => {
        if (opts.running.get(opts.key) === started) opts.running.delete(opts.key);
    });
}

/**
 * L'identité vient de l'appelant : deux espaces qui suivent la même ville
 * partagent un relevé, et chacun doit y lire sa propre ville, pas celle de
 * l'autre.
 */
function withIdentity(report: WeatherReport, input: FetchReportInput): WeatherReport {
    return { ...report, locationId: input.locationId, label: input.label };
}

/** La lecture (`weather.get`) : le cache tant qu'il est frais, le fournisseur sinon. */
export async function fetchWeatherReport(input: FetchReportInput): Promise<WeatherReport> {
    const report = await throughCache({
        cache: reportCache,
        running: reportsInFlight,
        key: reportCacheKey(input),
        ttl: REPORT_TTL_MS,
        provider: input.provider,
        workspaceId: input.workspaceId,
        call: () => adapterFor(input.provider).fetchReport(input)
    });
    return withIdentity(report, input);
}

/** La recherche d'une ville (`weather.add`), au même régime que les relevés. */
export function geocodeLocation(input: GeocodeInput): Promise<GeocodeResult> {
    return throughCache({
        cache: geocodeCache,
        running: geocodesInFlight,
        key: `${input.provider}|${input.query.trim().toLowerCase()}`,
        ttl: GEOCODE_TTL_MS,
        provider: input.provider,
        workspaceId: input.workspaceId,
        call: () => adapterFor(input.provider).geocode(input.query, input.apiKey)
    });
}

/** Un appel minimal à Open-Meteo avec la clé de l'instance, pour la page Services externes. */
export async function probeOpenMeteo(): Promise<void> {
    const params = new URLSearchParams({ latitude: '48.85', longitude: '2.35', current: 'temperature_2m' });
    await openMeteoJson<OpenMeteoForecast>(openMeteoUrl('api', '/v1/forecast', params));
}
