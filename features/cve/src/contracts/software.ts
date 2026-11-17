import { z } from 'zod';

/**
 * Un logiciel tel qu'endoflife.date le décrit : ses branches et les dates où
 * chacune cesse d'être suivie. Les dates sont des jours `AAAA-MM-JJ`.
 */

export const softwareReleaseSchema = z.object({
    name: z.string(),
    /** Le libellé d'endoflife.date quand il diffère du nom (« 26.04 'Resolute Raccoon' (LTS) »). */
    label: z.string().nullable(),
    releaseDate: z.string().nullable(),
    isLts: z.boolean(),
    /** Fin du support actif : ensuite, les seuls correctifs de sécurité. */
    eoasFrom: z.string().nullable(),
    /** Fin de vie : plus aucun correctif, même de sécurité. */
    eolFrom: z.string().nullable(),
    isEol: z.boolean(),
    /** Fin du support étendu, souvent payant. */
    eoesFrom: z.string().nullable(),
    isMaintained: z.boolean(),
    latest: z.string().nullable(),
    latestDate: z.string().nullable()
});
export type SoftwareRelease = z.infer<typeof softwareReleaseSchema>;

export const softwareSchema = z.object({
    /** Le nom chez endoflife.date (`nodejs`). */
    name: z.string(),
    label: z.string(),
    category: z.string().nullable(),
    link: z.string().nullable(),
    /** Les colonnes que ce logiciel remplit en plus de la fin de vie. */
    hasEoas: z.boolean(),
    hasEoes: z.boolean(),
    /** La plus récente d'abord, comme endoflife.date les range. */
    releases: z.array(softwareReleaseSchema),
    /** Le dernier chargement du catalogue, en secondes. */
    fetchedAt: z.number().int().nonnegative()
});
export type Software = z.infer<typeof softwareSchema>;

/** La fiche d'un logiciel, par son nom chez endoflife.date. */
export const cveSoftware = {
    command: 'cve.software' as const,
    input: z.object({ name: z.string().min(1).max(100) }),
    output: z.object({ software: softwareSchema })
};

/** Ce que la recherche rend au plus de logiciels. */
export const SOFTWARE_MATCHES_MAX = 5;

/**
 * Les logiciels qu'une recherche nomme, et la version qu'elle donne.
 * `releases` : les branches de cette version chez chacun, à surligner.
 */
export const cveSoftwareSearch = {
    command: 'cve.softwareSearch' as const,
    input: z.object({ query: z.string().trim().min(1).max(120) }),
    output: z.object({
        matches: z.array(z.object({ software: softwareSchema, releases: z.array(z.string()) })),
        version: z.string().nullable(),
        /** Les logiciels trouvés au-delà de ceux rendus. */
        more: z.number().int().nonnegative()
    })
};
