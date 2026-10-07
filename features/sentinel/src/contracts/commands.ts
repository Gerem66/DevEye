import { z } from 'zod';
import {
    allowEntrySchema,
    allowScopeSchema,
    baselineEntrySchema,
    baselineKindSchema,
    devicePostureSchema,
    deviceSentinelStateSchema,
    findingSchema,
    findingSeveritySchema,
    findingStateSchema,
    SENTINEL_INTEGRITY_MINUTES_MAX,
    SENTINEL_INTEGRITY_MINUTES_MIN,
    SENTINEL_LEARNING_DAYS_MAX,
    SENTINEL_LEARNING_DAYS_MIN,
    sentinelRuleIdSchema,
    severityCountsSchema
} from './domain';

const deviceId = z.uuid();
const findingId = z.number().int().positive();

/** Plafond d'une page de constats. Au-delà, on filtre plutôt qu'on déroule. */
export const SENTINEL_PAGE_MAX = 200;

/** Un constat, ou tout un groupe de la liste (même règle, même appareil) : jamais plus qu'une page. */
const findingIds = z.array(findingId).min(1).max(SENTINEL_PAGE_MAX);

/**
 * L'état de la flotte en une réponse : de quoi peindre la carte d'accueil et
 * l'en-tête de la vue plein écran sans second aller-retour.
 */
export const sentinelOverview = {
    command: 'sentinel.overview' as const,
    input: z.object({}),
    output: z.object({
        /** Constats ouverts de tout l'espace, par gravité. */
        open: severityCountsSchema,
        /** Moyenne des scores concluants. `null` sans posture mesurable, et non `0`, qui se lirait comme une flotte en ruine. */
        fleetScore: z.number().int().min(0).max(100).nullable(),
        devices: z.array(deviceSentinelStateSchema).max(500)
    })
};

/** Séparé d'`overview` : il se rafraîchit à chaque changement et n'a besoin d'aucune jointure. */
export const sentinelCount = {
    command: 'sentinel.count' as const,
    input: z.object({}),
    output: z.object({
        open: severityCountsSchema,
        /** Appareils sur lesquels Sentinelle est active. */
        watched: z.number().int().nonnegative()
    })
};

/** Les constats, filtrables. Tri imposé : gravité décroissante puis fraîcheur. */
export const sentinelFindings = {
    command: 'sentinel.findings' as const,
    input: z.object({
        deviceId: deviceId.nullable().default(null),
        state: findingStateSchema.nullable().default(null),
        minSeverity: findingSeveritySchema.nullable().default(null),
        rule: sentinelRuleIdSchema.nullable().default(null),
        limit: z.number().int().min(1).max(SENTINEL_PAGE_MAX).default(50),
        offset: z.number().int().nonnegative().default(0)
    }),
    output: z.object({
        findings: z.array(findingSchema).max(SENTINEL_PAGE_MAX),
        /** Total correspondant au filtre, pour paginer sans deviner. */
        total: z.number().int().nonnegative()
    })
};

/** L'inventaire appris d'une machine, par nature. */
export const sentinelBaseline = {
    command: 'sentinel.baseline' as const,
    input: z.object({
        deviceId,
        kind: baselineKindSchema.nullable().default(null),
        limit: z.number().int().min(1).max(1000).default(500)
    }),
    output: z.object({
        deviceId,
        entries: z.array(baselineEntrySchema).max(1000),
        total: z.number().int().nonnegative()
    })
};

/** Le détail de posture d'une machine, contrôle par contrôle. */
export const sentinelPosture = {
    command: 'sentinel.posture' as const,
    input: z.object({ deviceId }),
    output: z.object({ posture: devicePostureSchema })
};

/**
 * Pour chaque constat, écrit une autorisation puis l'acquitte, dans cet ordre :
 * si l'écriture échoue, le constat reste ouvert. En portée `fleet`, vaut pour
 * tout l'espace. Un constat déjà acquitté est laissé tel quel. Rend les
 * constats tels qu'ils sont après coup.
 */
export const sentinelAcknowledge = {
    command: 'sentinel.acknowledge' as const,
    input: z.object({
        findingIds,
        scope: allowScopeSchema.default('device'),
        reason: z.string().max(255).nullable().default(null)
    }),
    output: z.object({ findings: z.array(findingSchema) })
};

/**
 * Ferme sans écrire d'autorisation : un constat réglé rouvre au premier relevé
 * qui le revoit, un acquitté jamais. Nécessaire pour les constats d'événement
 * (authentification, persistance), que rien ne cessera de déclencher. Seuls
 * les constats ouverts du lot sont fermés ; s'il n'y en a aucun, `conflict`.
 */
export const sentinelResolve = {
    command: 'sentinel.resolve' as const,
    input: z.object({ findingIds }),
    output: z.object({ findings: z.array(findingSchema) })
};

/** Annule un acquittement ou une résolution : retire l'autorisation et rouvre le constat. */
export const sentinelReopen = {
    command: 'sentinel.reopen' as const,
    input: z.object({ findingId }),
    output: z.object({ finding: findingSchema })
};

/** Les décisions humaines en vigueur dans l'espace. */
export const sentinelAllowlist = {
    command: 'sentinel.allowlist' as const,
    input: z.object({ deviceId: deviceId.nullable().default(null) }),
    output: z.object({ entries: z.array(allowEntrySchema).max(1000) })
};

/** Retire une autorisation. Le constat correspondant pourra rouvrir. */
export const sentinelRemoveAllow = {
    command: 'sentinel.removeAllow' as const,
    input: z.object({ allowId: z.number().int().positive() }),
    output: z.object({ removed: z.boolean() })
};

/**
 * Activer (re)part une fenêtre d'apprentissage : sans elle, le premier jour
 * produirait des centaines de « nouveau programme ».
 */
export const sentinelSetConfig = {
    command: 'sentinel.setConfig' as const,
    input: z.object({
        deviceId,
        enabled: z.boolean(),
        learningDays: z
            .number()
            .int()
            .min(SENTINEL_LEARNING_DAYS_MIN)
            .max(SENTINEL_LEARNING_DAYS_MAX)
            .nullable()
            .default(null),
        integrityMinutes: z
            .number()
            .int()
            .min(SENTINEL_INTEGRITY_MINUTES_MIN)
            .max(SENTINEL_INTEGRITY_MINUTES_MAX)
            .nullable()
            .default(null),
        authEvents: z.boolean().nullable().default(null),
        pinEvidence: z.boolean().nullable().default(null)
    }),
    output: z.object({ device: deviceSentinelStateSchema })
};

/** Demande un relevé de persistance + authentification immédiat. */
export const sentinelScanNow = {
    command: 'sentinel.scanNow' as const,
    input: z.object({ deviceId }),
    /** `requested` est faux quand l'agent n'est pas connecté. */
    output: z.object({ deviceId, requested: z.boolean() })
};

/**
 * Efface la ligne de base et relance l'apprentissage (après une montée de
 * version d'agent qui change ce qui est observé). Les autorisations
 * survivent : ce sont des décisions.
 */
export const sentinelResetBaseline = {
    command: 'sentinel.resetBaseline' as const,
    input: z.object({ deviceId }),
    output: z.object({ deviceId, cleared: z.number().int().nonnegative() })
};

export const sentinelCommands = [
    sentinelOverview,
    sentinelCount,
    sentinelFindings,
    sentinelBaseline,
    sentinelPosture,
    sentinelAcknowledge,
    sentinelResolve,
    sentinelReopen,
    sentinelAllowlist,
    sentinelRemoveAllow,
    sentinelSetConfig,
    sentinelScanNow,
    sentinelResetBaseline
] as const;
