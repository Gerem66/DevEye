import { z } from 'zod';
import {
    cveEntrySchema,
    cveIdSchema,
    cveProviderKeySchema,
    cveProviderSchema,
    cveSeverityFilterSchema
} from './domain';
import {
    exposureAssetSchema,
    exposureComponentSchema,
    exposureCountsSchema,
    exposureFindingSchema,
    exposurePrefsSchema
} from './exposure';

/** Ce qu'une liste rend au plus, fil comme recherche. */
export const CVE_PAGE_MAX = 100;
export const CVE_SEARCH_QUERY_MAX = 120;

/** Le fil : les dernières CVE publiées, la plus récente d'abord. */
export const cveNews = {
    command: 'cve.news' as const,
    input: z.object({
        severity: cveSeverityFilterSchema.default('all'),
        limit: z.number().int().min(1).max(CVE_PAGE_MAX).default(50)
    }),
    output: z.object({
        entries: z.array(cveEntrySchema),
        /** Date du dernier tour d'ingestion réussi, `null` tant qu'il n'y en a pas eu. */
        ingestedAt: z.number().int().nonnegative().nullable()
    })
};

/**
 * La recherche, en deux jambes : le catalogue local d'abord, le NVD ensuite si
 * le local ne suffit pas. La sortie dit franchement ce qui a répondu, pour que
 * l'écran ne laisse pas croire à une absence quand c'est le tiers qui a manqué.
 */
export const cveSearch = {
    command: 'cve.search' as const,
    input: z.object({
        query: z.string().trim().min(1).max(CVE_SEARCH_QUERY_MAX),
        severity: cveSeverityFilterSchema.default('all'),
        limit: z.number().int().min(1).max(CVE_PAGE_MAX).default(50)
    }),
    output: z.object({
        entries: z.array(cveEntrySchema),
        /** Plus de correspondances que `limit` : l'écran doit le dire. */
        truncated: z.boolean(),
        /** La jambe distante a tourné. */
        remote: z.boolean(),
        remoteError: z.string().nullable()
    })
};

/** Une CVE en détail, cherchée chez le fournisseur si le catalogue l'ignore. */
export const cveGet = {
    command: 'cve.get' as const,
    input: z.object({ id: cveIdSchema }),
    output: z.object({ entry: cveEntrySchema })
};

/** Les CVE épinglées par l'espace, la plus récemment épinglée d'abord. */
export const cveFavorites = {
    command: 'cve.favorites' as const,
    input: z.object({}),
    output: z.object({ entries: z.array(cveEntrySchema) })
};

/** Épingler ou retirer, pour tout l'espace. */
export const cveSetFavorite = {
    command: 'cve.setFavorite' as const,
    input: z.object({ id: cveIdSchema, favorite: z.boolean() }),
    output: z.object({ entry: cveEntrySchema })
};

/** L'état des clés d'espace par fournisseur, jamais les clés elles-mêmes. */
export const cveKeyList = {
    command: 'cve.keyList' as const,
    input: z.object({}),
    output: z.object({ keys: z.array(cveProviderKeySchema) })
};

/** Poser une clé, ou l'effacer avec une chaîne vide. */
export const cveSetKey = {
    command: 'cve.setKey' as const,
    input: z.object({ provider: cveProviderSchema, key: z.string().max(256) }),
    output: z.object({ keys: z.array(cveProviderKeySchema) })
};

/** Ce que la raison d'un constat ignoré peut dire. */
export const FINDING_REASON_MAX = 500;

/**
 * Les constats de l'espace. `active` : ouverts et ignorés, ce qui demande une
 * décision ou en a reçu une ; `resolved` : ce qui ne touche plus rien.
 */
export const cveExposure = {
    command: 'cve.exposure' as const,
    input: z.object({ view: z.enum(['active', 'resolved']).default('active') }),
    output: z.object({
        findings: z.array(exposureFindingSchema),
        /** La dernière lecture d'un élément, toutes sources confondues. */
        scannedAt: z.number().int().nonnegative().nullable(),
        /** Ce que la dernière évaluation n'a pas pu vérifier (un catalogue qui n'a pas répondu). */
        notices: z.array(z.string())
    })
};

/** Le décompte de la carte : il répond coffre verrouillé, rien n'y est déchiffré. */
export const cveExposureCount = {
    command: 'cve.exposureCount' as const,
    input: z.object({}),
    output: exposureCountsSchema
};

/** Les éléments que la veille lit, et ce qu'elle y a trouvé. */
export const cveInventory = {
    command: 'cve.inventory' as const,
    input: z.object({}),
    output: z.object({ assets: z.array(exposureAssetSchema) })
};

/** Un élément et ses composants. */
export const cveAsset = {
    command: 'cve.asset' as const,
    input: z.object({ id: z.number().int().positive() }),
    output: z.object({ asset: exposureAssetSchema, components: z.array(exposureComponentSchema) })
};

/** Ignorer un constat, pour les éléments qu'il touche à cet instant. */
export const cveFindingIgnore = {
    command: 'cve.findingIgnore' as const,
    input: z.object({
        id: z.number().int().positive(),
        reason: z.string().trim().max(FINDING_REASON_MAX).default('')
    }),
    output: z.object({ finding: exposureFindingSchema })
};

export const cveFindingRestore = {
    command: 'cve.findingRestore' as const,
    input: z.object({ id: z.number().int().positive() }),
    output: z.object({ finding: exposureFindingSchema })
};

/** Relire un élément au prochain passage, sans attendre son tour. */
export const cveAssetRefresh = {
    command: 'cve.assetRefresh' as const,
    input: z.object({ id: z.number().int().positive() }),
    output: z.object({ asset: exposureAssetSchema })
};

/** Sortir un élément de la veille, ou l'y remettre. */
export const cveAssetExclude = {
    command: 'cve.assetExclude' as const,
    input: z.object({ id: z.number().int().positive(), excluded: z.boolean() }),
    output: z.object({ asset: exposureAssetSchema })
};

/** Ce que l'espace règle de sa veille. */
export const cveExposurePrefs = {
    command: 'cve.exposurePrefs' as const,
    input: z.object({}),
    output: z.object({ prefs: exposurePrefsSchema })
};

export const cveSetExposurePrefs = {
    command: 'cve.setExposurePrefs' as const,
    input: z.object({ prefs: exposurePrefsSchema }),
    output: z.object({ prefs: exposurePrefsSchema })
};

export const cveCommands = [
    cveNews,
    cveSearch,
    cveGet,
    cveFavorites,
    cveSetFavorite,
    cveKeyList,
    cveSetKey,
    cveExposure,
    cveExposureCount,
    cveInventory,
    cveAsset,
    cveFindingIgnore,
    cveFindingRestore,
    cveAssetRefresh,
    cveAssetExclude,
    cveExposurePrefs,
    cveSetExposurePrefs
] as const;
