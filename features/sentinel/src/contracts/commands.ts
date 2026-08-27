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
        /**
         * Score de posture de la flotte : moyenne des scores concluants. `null`
         * quand aucune machine n'a encore de posture mesurable, et non `0`, qui
         * se lirait comme une flotte en ruine.
         */
        fleetScore: z.number().int().min(0).max(100).nullable(),
        devices: z.array(deviceSentinelStateSchema).max(500)
    })
};

/**
 * Le décompte seul, pour la carte de grille et la pastille de Monitoring.
 *
 * Séparé d'`overview` parce qu'il se rafraîchit à chaque changement et qu'il
 * n'a besoin d'aucune jointure : deux `COUNT` indexés contre un balayage de
 * toute la flotte.
 */
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
 * « Ceci est légitime. »
 *
 * Écrit une autorisation **et** résout le constat, dans cet ordre : si l'écriture
 * échoue, le constat reste ouvert plutôt que de disparaître sans qu'aucune règle
 * ne l'en empêche de revenir. En portée `fleet`, l'autorisation vaut pour tout
 * l'espace, y compris les machines qui le rejoindront ensuite.
 */
export const sentinelAcknowledge = {
    command: 'sentinel.acknowledge' as const,
    input: z.object({
        findingId,
        scope: allowScopeSchema.default('device'),
        reason: z.string().max(255).nullable().default(null)
    }),
    output: z.object({
        finding: findingSchema,
        allow: allowEntrySchema
    })
};

/**
 * « C'est réglé. »
 *
 * Ferme le constat **sans** écrire d'autorisation : la situation a cessé, elle
 * n'a pas été jugée normale. La distinction n'est pas cosmétique, un constat
 * acquitté ne rouvrira plus jamais, un constat réglé rouvre au premier relevé
 * qui le revoit, et c'est précisément ce qu'on veut d'une correction.
 *
 * Le moteur résout tout seul ce qu'il sait rejouer (les règles d'instant). Restent
 * les constats d'**événement**, une authentification, une entrée de persistance :
 * ils décrivent quelque chose qui a eu lieu, donc rien ne cessera de les
 * déclencher, et sans cette commande la seule sortie était de les déclarer
 * légitimes. C'est-à-dire de mentir pour faire le ménage.
 */
export const sentinelResolve = {
    command: 'sentinel.resolve' as const,
    input: z.object({ findingId }),
    output: z.object({ finding: findingSchema })
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
 * Active Sentinelle sur une machine et règle ses cadences.
 *
 * Activer (re)part une fenêtre d'apprentissage de `learningDays` : sans elle, le
 * premier jour produirait des centaines de constats « nouveau programme » et la
 * liste deviendrait illisible avant d'avoir servi.
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
        authEvents: z.boolean().nullable().default(null)
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
 * Efface la ligne de base d'une machine et relance l'apprentissage.
 *
 * Le geste à faire après une montée de version d'agent qui change ce qui est
 * observé, typiquement l'arrivée des chemins d'exécutables, qui redéfinit la
 * clé d'un programme. **Les autorisations survivent** : ce sont des décisions,
 * pas des observations, et les réclamer une seconde fois serait une punition
 * pour avoir mis l'agent à jour.
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
