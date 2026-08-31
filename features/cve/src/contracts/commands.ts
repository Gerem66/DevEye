import { z } from 'zod';
import {
    cveEntrySchema,
    cveIdSchema,
    cveProviderKeySchema,
    cveProviderSchema,
    cveSeverityFilterSchema
} from './domain';

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

export const cveCommands = [cveNews, cveSearch, cveGet, cveFavorites, cveSetFavorite, cveKeyList, cveSetKey] as const;
