import { z } from 'zod';
import { weatherFormatSchema, weatherLocationSchema, weatherProviderSchema, weatherReportSchema } from './domain';

const locationId = z.uuid();

export const weatherList = {
    command: 'weather.list' as const,
    input: z.object({}),
    output: z.object({ locations: z.array(weatherLocationSchema) })
};

/** Ajouter une ville par son nom : le serveur la géocode. */
export const weatherAdd = {
    command: 'weather.add' as const,
    input: z.object({
        query: z.string().min(1).max(120),
        format: weatherFormatSchema.default('current'),
        days: z.number().int().min(1).max(16).default(7),
        provider: weatherProviderSchema.default('open-meteo')
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
        provider: weatherProviderSchema.optional()
    }),
    output: z.object({ location: weatherLocationSchema })
};

export const weatherRemove = {
    command: 'weather.remove' as const,
    input: z.object({ id: locationId }),
    output: z.object({ id: locationId })
};

/** Réordonner les villes de l'espace : `ids` est le nouvel ordre complet. */
export const weatherReorder = {
    command: 'weather.reorder' as const,
    input: z.object({ ids: z.array(locationId).min(1) }),
    output: z.object({ locations: z.array(weatherLocationSchema) })
};

/** Faire d'une ville la principale, à la place de celle qui l'était. */
export const weatherSetPrimary = {
    command: 'weather.setPrimary' as const,
    input: z.object({ id: locationId }),
    output: z.object({ locations: z.array(weatherLocationSchema) })
};

/** Le relevé d'une ville suivie. */
export const weatherGet = {
    command: 'weather.get' as const,
    input: z.object({ id: locationId }),
    output: z.object({ report: weatherReportSchema })
};

/** L'état des clés d'espace par fournisseur, jamais les clés elles-mêmes. */
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

/** Poser la clé d'API de l'espace pour un fournisseur, ou la retirer par une chaîne vide. */
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
