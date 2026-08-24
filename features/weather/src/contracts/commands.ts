import { z } from 'zod';
import { weatherFormatSchema, weatherLocationSchema, weatherProviderSchema, weatherReportSchema } from './domain';

const locationId = z.uuid();

export const weatherList = {
    command: 'weather.list' as const,
    input: z.object({}),
    output: z.object({ locations: z.array(weatherLocationSchema) })
};

/** Add a weather widget by city name; the server geocodes it to coordinates. */
export const weatherAdd = {
    command: 'weather.add' as const,
    input: z.object({
        query: z.string().min(1).max(120),
        format: weatherFormatSchema.default('current'),
        days: z.number().int().min(1).max(16).default(7),
        provider: weatherProviderSchema.default('open-meteo'),
        /** Optional per-city API key for the chosen provider. */
        apiKey: z.string().max(256).optional()
    }),
    output: z.object({ location: weatherLocationSchema })
};

export const weatherUpdate = {
    command: 'weather.update' as const,
    input: z.object({
        id: locationId,
        format: weatherFormatSchema.optional(),
        days: z.number().int().min(1).max(16).optional(),
        position: z.number().int().nonnegative().optional(),
        provider: weatherProviderSchema.optional(),
        /** Per-city API key: a non-empty string sets it, "" clears it, undefined leaves it. */
        apiKey: z.string().max(256).optional()
    }),
    output: z.object({ location: weatherLocationSchema })
};

export const weatherRemove = {
    command: 'weather.remove' as const,
    input: z.object({ id: locationId }),
    output: z.object({ id: locationId })
};

/** Reorder all of the user's locations; `ids` is the new full order. */
export const weatherReorder = {
    command: 'weather.reorder' as const,
    input: z.object({ ids: z.array(locationId).min(1) }),
    output: z.object({ locations: z.array(weatherLocationSchema) })
};

/** Mark one location as primary (topbar + widget); clears it on the others. */
export const weatherSetPrimary = {
    command: 'weather.setPrimary' as const,
    input: z.object({ id: locationId }),
    output: z.object({ locations: z.array(weatherLocationSchema) })
};

/** Fetch a live report for a configured location. */
export const weatherGet = {
    command: 'weather.get' as const,
    input: z.object({ id: locationId }),
    output: z.object({ report: weatherReportSchema })
};

/**
 * L'état des clés d'espace, par fournisseur — jamais les clés elles-mêmes.
 *
 * Le panneau Sources de la Météo a besoin de dire « clé enregistrée » ou
 * « aucune clé » : le fait, pas le secret, exactement comme `osint.keyList`.
 */
export const weatherKeyList = {
    command: 'weather.keyList' as const,
    input: z.object({}),
    output: z.object({
        providers: z.array(
            z.object({
                provider: weatherProviderSchema,
                hasKey: z.boolean()
            })
        )
    })
};

/** Store or clear the per-account API key for an advanced provider. */
export const weatherSetKey = {
    command: 'weather.setKey' as const,
    input: z.object({
        provider: weatherProviderSchema,
        key: z.string().max(256)
    }),
    output: z.object({ provider: weatherProviderSchema, hasKey: z.boolean() })
};

export const weatherCommands = [
    weatherList,
    weatherAdd,
    weatherUpdate,
    weatherRemove,
    weatherReorder,
    weatherSetPrimary,
    weatherGet,
    weatherKeyList,
    weatherSetKey
] as const;
