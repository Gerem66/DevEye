import { z } from 'zod';

import { CONVERT_KINDS } from './catalogue';
import { optionValuesSchema } from './options';

export const convertKindSchema = z.enum(CONVERT_KINDS);

/**
 * Le parcours d'un travail. `uploading` est un état et non un drapeau : c'est
 * lui qui interdit deux envois du même fichier, et le seul dont un redémarrage
 * ne se remet pas (le fichier reçu est tronqué).
 */
export const convertPhaseSchema = z.enum([
    'awaiting_upload',
    'uploading',
    'queued',
    'running',
    'done',
    'error',
    'canceled',
    'expired'
]);
export type ConvertPhase = z.infer<typeof convertPhaseSchema>;

/** Un travail qui tient encore des octets sur le disque, ou qui va en recevoir. */
export const LIVE_PHASES: readonly ConvertPhase[] = ['awaiting_upload', 'uploading', 'queued', 'running', 'done'];

/** Pourquoi un travail a échoué : un vocabulaire fermé, que l'écran traduit. */
export const convertErrorCodeSchema = z.enum([
    'unsupported',
    'format_mismatch',
    'engine_missing',
    'timeout',
    'stalled',
    'too_large',
    'output_too_large',
    'target_too_small',
    'disk_full',
    'corrupt',
    'upload_interrupted',
    'interrupted',
    'engine_failed'
]);
export type ConvertErrorCode = z.infer<typeof convertErrorCodeSchema>;

export const FILE_NAME_MAX = 255;

export const convertJobSchema = z.object({
    id: z.number().int().positive(),
    kind: convertKindSchema,
    sourceFormat: z.string(),
    targetFormat: z.string(),
    /** `null` quand le nom ne se lit plus (clé changée) : l'écran en donne un générique. */
    originalName: z.string().nullable(),
    options: optionValuesSchema,
    inputBytes: z.number().int().nonnegative(),
    outputBytes: z.number().int().nonnegative().nullable(),
    phase: convertPhaseSchema,
    /** En millièmes : au pour cent, la barre d'une longue vidéo a l'air figée. */
    progress: z.number().int().min(0).max(1000),
    errorCode: convertErrorCodeSchema.nullable(),
    /** Le détail de l'échec, en français, quand il y en a un à dire. */
    errorMessage: z.string().nullable(),
    userId: z.number().int().positive(),
    createdAt: z.number().int().nonnegative(),
    finishedAt: z.number().int().nonnegative().nullable(),
    /** Quand le résultat sera retiré du serveur. */
    expiresAt: z.number().int().nonnegative().nullable()
});
export type ConvertJob = z.infer<typeof convertJobSchema>;

/** La trame d'avancement : le changement, jamais l'état. Une trame perdue ne coûte rien, la liste fait foi. */
export const CONVERT_PROGRESS_EVENT = 'convert.progress';
export const convertProgressSchema = z.object({
    jobId: z.number().int().positive(),
    progress: z.number().int().min(0).max(1000),
    /** Secondes restantes, `null` tant qu'on ne sait pas les dire. */
    etaSeconds: z.number().int().nonnegative().nullable()
});
export type ConvertProgress = z.infer<typeof convertProgressSchema>;

/** Une famille telle que CE serveur la sert : présente, ou dite absente avec sa raison. */
export const convertFamilySchema = z.object({
    kind: convertKindSchema,
    available: z.boolean(),
    /** Une phrase qui nomme l'outil manquant. `null` quand tout répond. */
    reason: z.string().nullable(),
    /** Les formats du catalogue que les outils installés ne savent pas lire, et ceux qu'ils ne savent pas écrire. */
    missingSources: z.array(z.string()),
    missingTargets: z.array(z.string())
});
export type ConvertFamily = z.infer<typeof convertFamilySchema>;

export const CURRENCY_CODE = /^[A-Z]{3}$/;
export const currencyCodeSchema = z.string().regex(CURRENCY_CODE);

export const convertSettingsSchema = z.object({
    /** La devise proposée en premier dans le convertisseur de devises. */
    baseCurrency: currencyCodeSchema.default('EUR'),
    /** Prévenir à la fin d'un travail qui a duré au moins autant, en secondes. 0 : toujours. */
    notifyAfterSeconds: z.number().int().min(0).max(3600).default(60)
});
export type ConvertSettings = z.infer<typeof convertSettingsSchema>;
export const DEFAULT_SETTINGS: ConvertSettings = { baseCurrency: 'EUR', notifyAfterSeconds: 60 };
