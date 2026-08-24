import { z } from 'zod';

/** Display mode of a weather widget instance. */
export const weatherFormatSchema = z.enum(['current', 'daily']);
export type WeatherFormat = z.infer<typeof weatherFormatSchema>;

/** Weather data provider. Open-Meteo needs no key; others use a per-account key. */
export const weatherProviderSchema = z.enum(['open-meteo', 'openweathermap']);
export type WeatherProvider = z.infer<typeof weatherProviderSchema>;

/**
 * A user-configured weather widget instance. Multiple may exist (one per city),
 * each with its own format. Coordinates are resolved via geocoding when added.
 */
export const weatherLocationSchema = z.object({
    id: z.uuid(),
    label: z.string().min(1).max(120),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    format: weatherFormatSchema,
    /** Number of forecast days for the `daily` format (1..16). */
    days: z.number().int().min(1).max(16),
    provider: weatherProviderSchema,
    position: z.number().int().nonnegative(),
    /** The primary city: shown in the topbar and the home widget. */
    isPrimary: z.boolean(),
    /** Whether a per-city API key is configured. The key itself is never sent. */
    hasApiKey: z.boolean()
});

export type WeatherLocation = z.infer<typeof weatherLocationSchema>;

export const weatherConditionSchema = z.object({
    /** WMO weather code (mapped to icon/label client-side). */
    code: z.number().int(),
    temperature: z.number(),
    apparentTemperature: z.number().nullable(),
    humidity: z.number().nullable(),
    windSpeed: z.number().nullable(),
    isDay: z.boolean().nullable()
});

export type WeatherCondition = z.infer<typeof weatherConditionSchema>;

export const weatherDaySchema = z.object({
    date: z.string(),
    code: z.number().int(),
    tempMin: z.number(),
    tempMax: z.number(),
    precipitationProbability: z.number().nullable()
});

export type WeatherDay = z.infer<typeof weatherDaySchema>;

export const weatherHourSchema = z.object({
    /** ISO local time of the hour (e.g. "2026-06-17T14:00"). */
    time: z.string(),
    code: z.number().int(),
    temperature: z.number(),
    precipitationProbability: z.number().nullable()
});

export type WeatherHour = z.infer<typeof weatherHourSchema>;

/** Live report fetched on demand for a given location. */
export const weatherReportSchema = z.object({
    locationId: z.uuid(),
    label: z.string(),
    fetchedAt: z.number().int().nonnegative(),
    /** IANA timezone of the location (e.g. "Europe/Paris"), for local-date display. */
    timezone: z.string(),
    /** The provider that produced this report (shown discreetly client-side). */
    provider: weatherProviderSchema,
    current: weatherConditionSchema.nullable(),
    /** Hour-by-hour forecast for roughly the next 24 hours. */
    hourly: z.array(weatherHourSchema),
    daily: z.array(weatherDaySchema)
});

export type WeatherReport = z.infer<typeof weatherReportSchema>;

export interface WeatherLocationRow {
    id: string;
    user_id: number;
    workspace_id: number;
    label: string;
    latitude: number;
    longitude: number;
    format: WeatherFormat;
    days: number;
    provider: WeatherProvider;
    position: number;
    is_primary: number;
    /** Encrypted per-city API key (zero-knowledge at rest); null when unset. */
    api_key_enc: string | null;
    created: number;
}

export interface WeatherProviderKeyRow {
    workspace_id: number;
    provider: WeatherProvider;
    /** Encrypted API key (zero-knowledge at rest). */
    key_enc: string;
    created: number;
}
