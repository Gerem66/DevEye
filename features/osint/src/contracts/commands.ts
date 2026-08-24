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
 * OSINT — sept commandes, dont deux portent toute la feature.
 *
 * `osint.lookup` ne sonde rien : il **planifie**. Il reconnaît la cible,
 * enregistre la recherche et rend la liste des sondes applicables. Le client
 * affiche aussitôt une carte squelette par sonde, puis tire un `osint.probe`
 * par carte, toutes en parallèle.
 *
 * C'est ce découpage qui fait l'affichage progressif sans inventer de protocole :
 * une sonde lente (crt.sh, ~3 s) n'en retarde aucune autre, une sonde en échec
 * n'a qu'une carte à elle, et « réessayer » ne relance qu'elle. Une commande
 * unique qui aurait tout attendu aurait laissé l'écran vide pendant la plus
 * lente des sondes.
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
 * Exécute **une** sonde. La cible vient du client : le serveur la revalide par
 * `detectTarget()` et refuse une sonde qui ne s'applique pas à sa nature — le
 * `kind` reçu n'est jamais cru sur parole.
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
    output: z.object({
        providers: z.array(osintProviderStatusSchema),
        /**
         * Combien de sondes peuvent rendre quelque chose aujourd'hui, sur le
         * total du registre — la plupart n'exigent aucune clé, seules
         * quelques-unes en dépendent (`skipped` sans elle). Rendu ici plutôt
         * que par une commande à part : le calcul part du même ensemble de
         * fournisseurs posés que `providers`, pas la peine de le relire deux fois.
         */
        probesAvailable: z.number().int().nonnegative(),
        probesTotal: z.number().int().positive()
    })
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
