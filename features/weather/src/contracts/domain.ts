import { z } from 'zod';

/** Le mode d'affichage d'une ville. */
export const weatherFormatSchema = z.enum(['current', 'daily']);
export type WeatherFormat = z.infer<typeof weatherFormatSchema>;

/** Le fournisseur des relevés. Open-Meteo est sans clé, les autres passent par celle de l'espace. */
export const weatherProviderSchema = z.enum(['open-meteo', 'openweathermap']);
export type WeatherProvider = z.infer<typeof weatherProviderSchema>;

const KEYED_PROVIDERS: readonly WeatherProvider[] = ['openweathermap'];

/** Ce fournisseur exige-t-il une clé d'API ? Sans celle de l'espace, il est inutilisable. */
export function providerNeedsKey(provider: WeatherProvider): boolean {
    return KEYED_PROVIDERS.includes(provider);
}

/** Une ville suivie par l'espace. Ses coordonnées viennent du géocodage, à l'ajout. */
export const weatherLocationSchema = z.object({
    id: z.uuid(),
    label: z.string().min(1).max(120),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    format: weatherFormatSchema,
    /** Le nombre de jours de prévision demandés, de 1 à 16. */
    days: z.number().int().min(1).max(16),
    provider: weatherProviderSchema,
    position: z.number().int().nonnegative(),
    /** La ville principale : celle de la barre du haut et de la tuile d'accueil. */
    isPrimary: z.boolean()
});

export type WeatherLocation = z.infer<typeof weatherLocationSchema>;

export const weatherConditionSchema = z.object({
    /** Le code météo WMO, que le client traduit en icône. */
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
    /** L'heure locale du créneau, en ISO (« 2026-06-17T14:00 »). */
    time: z.string(),
    code: z.number().int(),
    temperature: z.number(),
    precipitationProbability: z.number().nullable()
});

export type WeatherHour = z.infer<typeof weatherHourSchema>;

/** Le relevé d'une ville, lu à la demande. */
export const weatherReportSchema = z.object({
    locationId: z.uuid(),
    label: z.string(),
    fetchedAt: z.number().int().nonnegative(),
    /** Le fuseau de la ville, tel qu'`Intl` l'accepte : un nom IANA (« Europe/Paris ») ou un décalage (« +02:00 »). */
    timezone: z.string(),
    /** Le fournisseur dont vient ce relevé. */
    provider: weatherProviderSchema,
    current: weatherConditionSchema.nullable(),
    /** Les créneaux à venir depuis le début du jour local, 32 au plus, au pas du fournisseur (une ou trois heures). */
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
    created: number;
}

export interface WeatherProviderKeyRow {
    workspace_id: number;
    provider: WeatherProvider;
    /** La clé d'API, chiffrée au repos (palier ouvert : un serveur en marche la lit). */
    key_enc: string;
    created: number;
}
