import { z } from 'zod';

import {
    convertFamilySchema,
    convertJobSchema,
    convertKindSchema,
    convertSettingsSchema,
    FILE_NAME_MAX
} from './domain';
import { optionValuesSchema } from './options';

const jobIdInput = z.object({ jobId: z.number().int().positive() });

/** Ce que ce serveur sait convertir, et dans quelles limites pour l'appelant. */
export const convertCapabilities = {
    command: 'convert.capabilities' as const,
    input: z.object({}),
    output: z.object({
        families: z.array(convertFamilySchema),
        /** Le plus petit du mur du serveur et de l'offre du propriétaire de l'espace. */
        maxFileBytes: z.number().int().positive(),
        resultTtlSeconds: z.number().int().positive()
    })
};

/** Les travaux de l'espace, le plus récent d'abord : en cours, et ceux dont le résultat est encore là. */
export const convertList = {
    command: 'convert.list' as const,
    input: z.object({}),
    output: z.object({ jobs: z.array(convertJobSchema) })
};

/**
 * Ouvre un travail et rend de quoi monter le fichier. Rien n'est encore
 * converti : le travail part en file quand le fichier est arrivé en entier.
 */
export const convertCreate = {
    command: 'convert.create' as const,
    input: z.object({
        kind: convertKindSchema,
        sourceFormat: z.string().max(16),
        targetFormat: z.string().max(16),
        options: optionValuesSchema,
        originalName: z.string().trim().min(1).max(FILE_NAME_MAX),
        declaredBytes: z.number().int().positive()
    }),
    output: z.object({
        job: convertJobSchema,
        /** Où envoyer les octets, en `POST` brut. Vaut pour ce travail seul, un temps limité. */
        uploadUrl: z.string()
    })
};

export const convertCancel = {
    command: 'convert.cancel' as const,
    input: jobIdInput,
    output: z.object({ job: convertJobSchema })
};

/** L'adresse du résultat, à ouvrir telle quelle. Vaut deux minutes. */
export const convertDownload = {
    command: 'convert.download' as const,
    input: jobIdInput,
    output: z.object({ url: z.string() })
};

/** Retire un travail terminé, et son résultat du disque. Un travail en cours s'annule d'abord. */
export const convertRemove = {
    command: 'convert.remove' as const,
    input: jobIdInput,
    output: z.object({ removed: z.boolean() })
};

/** Les taux du jour contre l'euro. `stale` : la source n'a pas répondu, ce sont les derniers connus. */
export const convertRates = {
    command: 'convert.rates' as const,
    input: z.object({}),
    output: z.object({
        /** Le jour de publication chez la source, `AAAA-MM-JJ`. `null` tant qu'aucun taux n'a été lu. */
        asOf: z.string().nullable(),
        rates: z.record(z.string(), z.number().positive()),
        stale: z.boolean()
    })
};

export const convertSettingsGet = {
    command: 'convert.settingsGet' as const,
    input: z.object({}),
    output: z.object({ settings: convertSettingsSchema })
};

export const convertSettingsSet = {
    command: 'convert.settingsSet' as const,
    input: z.object({ settings: convertSettingsSchema }),
    output: z.object({ settings: convertSettingsSchema })
};

export const convertCommands = [
    convertCapabilities,
    convertList,
    convertCreate,
    convertCancel,
    convertDownload,
    convertRemove,
    convertRates,
    convertSettingsGet,
    convertSettingsSet
] as const;
