import { z } from 'zod';
import {
    OSINT_HISTORY_PAGE_MAX,
    OSINT_QUERY_MAX_LENGTH,
    osintHistoryEntrySchema,
    osintProbeIdSchema,
    osintProbeResultSchema,
    osintProviderSchema,
    osintProviderStatusSchema,
    osintTargetSchema
} from './domain';

/**
 * `osint.lookup` ne sonde rien : il planifie (reconnaît la cible, journalise,
 * rend les sondes applicables). Le client tire ensuite un `osint.probe` par
 * carte, en parallèle : une sonde lente n'en retarde aucune autre, et
 * « réessayer » ne relance qu'elle.
 */

const lookupId = z.uuid();

export const osintLookup = {
    command: 'osint.lookup' as const,
    input: z.object({ query: z.string().min(1).max(OSINT_QUERY_MAX_LENGTH) }),
    output: z.object({
        target: osintTargetSchema,
        probes: z.array(osintProbeIdSchema),
        /** L'entrée d'historique que cette recherche vient de créer. */
        entry: osintHistoryEntrySchema
    })
};

/**
 * Exécute une sonde. Le serveur revalide la cible par `detectTarget()` et refuse
 * une sonde qui ne s'applique pas à sa nature : le `kind` reçu n'est jamais cru.
 */
export const osintProbe = {
    command: 'osint.probe' as const,
    input: z.object({
        probe: osintProbeIdSchema,
        target: osintTargetSchema
    }),
    output: z.object({ result: osintProbeResultSchema })
};

export const osintHistory = {
    command: 'osint.history' as const,
    input: z.object({ limit: z.number().int().min(1).max(OSINT_HISTORY_PAGE_MAX).default(30) }),
    output: z.object({ entries: z.array(osintHistoryEntrySchema) })
};

export const osintHistoryRemove = {
    command: 'osint.historyRemove' as const,
    input: z.object({ id: lookupId }),
    output: z.object({ id: lookupId })
};

export const osintHistoryClear = {
    command: 'osint.historyClear' as const,
    input: z.object({}),
    output: z.object({ removed: z.number().int().nonnegative() })
};

export const osintKeyList = {
    command: 'osint.keyList' as const,
    input: z.object({}),
    /** Qui a une clé : ce qui en découle pour les sondes se lit dans `OSINT_PROBE_META`. */
    output: z.object({ providers: z.array(osintProviderStatusSchema) })
};

/** Pose ou efface la clé d'un fournisseur ; `key` vide efface. */
export const osintSetKey = {
    command: 'osint.setKey' as const,
    input: z.object({
        provider: osintProviderSchema,
        key: z.string().max(256)
    }),
    output: osintProviderStatusSchema
};

export const osintCommands = [
    osintLookup,
    osintProbe,
    osintHistory,
    osintHistoryRemove,
    osintHistoryClear,
    osintKeyList,
    osintSetKey
] as const;
