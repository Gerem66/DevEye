import { z } from 'zod';

/**
 * La gravité d'une vulnérabilité, normalisée depuis le CVSS v3.1 du NVD.
 * `none` couvre les CVE sans score publié, qui sont nombreuses les premiers
 * jours : elles existent, mais rien ne les qualifie encore.
 */
export const cveSeveritySchema = z.enum(['none', 'low', 'medium', 'high', 'critical']);
export type CveSeverity = z.infer<typeof cveSeveritySchema>;

/** Les gravités ordonnées, de la plus faible à la plus forte. */
export const CVE_SEVERITIES = cveSeveritySchema.options;

/** Le filtre de gravité d'une liste : `all` ne filtre rien. */
export const cveSeverityFilterSchema = z.enum(['all', ...CVE_SEVERITIES]);
export type CveSeverityFilter = z.infer<typeof cveSeverityFilterSchema>;

/** Un identifiant CVE, majuscules imposées : c'est la clé du catalogue. */
export const CVE_ID_PATTERN = /^CVE-\d{4}-\d{4,10}$/;
export const cveIdSchema = z
    .string()
    .trim()
    .toUpperCase()
    .regex(CVE_ID_PATTERN, 'Identifiant CVE attendu, de la forme CVE-2024-3094.');

/**
 * La longueur que la colonne `vector` accepte. Un vecteur CVSS v3.1 fait 44
 * caracteres, un v4.0 complet en approche 200 : la marge est deliberee.
 */
export const CVE_VECTOR_MAX = 320;

export const cveReferenceSchema = z.object({
    url: z.url({ protocol: /^https?$/ }),
    /**
     * Ce que le NVD dit de la page : « Patch », « Exploit », « Vendor Advisory ».
     * Son champ `source`, lui, ne sert à rien ici : c'est l'identifiant du CNA,
     * une adresse de courriel ou un UUID nu, jamais le nom d'un site.
     */
    tags: z.array(z.string().max(60)).max(8)
});
export type CveReference = z.infer<typeof cveReferenceSchema>;

/**
 * Une vulnérabilité du catalogue. Tout y est public : rien n'est chiffré, et
 * c'est ce qui permet la recherche en SQL.
 */
export const cveEntrySchema = z.object({
    id: cveIdSchema,
    /** Secondes epoch, comme partout dans le socle. */
    published: z.number().int().nonnegative(),
    lastModified: z.number().int().nonnegative(),
    severity: cveSeveritySchema,
    /** Le score CVSS de base, absent tant que la CVE n'est pas qualifiée. */
    score: z.number().min(0).max(10).nullable(),
    vector: z.string().max(CVE_VECTOR_MAX).nullable(),
    cwe: z.string().max(64).nullable(),
    summary: z.string(),
    references: z.array(cveReferenceSchema),
    /** Épinglée par l'espace de l'appelant. */
    isFavorite: z.boolean()
});
export type CveEntry = z.infer<typeof cveEntrySchema>;

/** Le fournisseur du catalogue. Un seul aujourd'hui, mais l'onglet Sources en liste. */
export const cveProviderSchema = z.enum(['nvd']);
export type CveProvider = z.infer<typeof cveProviderSchema>;

/** L'état d'une clé de fournisseur, jamais la clé elle-même. */
export const cveProviderKeySchema = z.object({
    provider: cveProviderSchema,
    hasKey: z.boolean()
});
export type CveProviderKey = z.infer<typeof cveProviderKeySchema>;

/**
 * Une ligne de `ft_cve_entries`. La table n'a PAS de `workspace_id` : le
 * catalogue du NVD est le même pour tout le monde.
 */
export interface CveEntryRow {
    cve_id: string;
    published: number;
    last_modified: number;
    severity: CveSeverity;
    score: number | null;
    vector: string | null;
    cwe: string | null;
    summary: string;
    refs: string | CveReference[];
    fetched_at: number;
}

/**
 * Une ligne de `ft_cve_entries` jointe aux favoris de l'espace consulté.
 * `favorite` porte le `cve_id` de l'épingle, `null` quand la jointure n'a rien
 * trouvé : sa présence est la réponse, pas sa valeur.
 */
export interface CveEntryWithFavoriteRow extends CveEntryRow {
    favorite: string | null;
}

export interface CveFavoriteRow {
    workspace_id: number;
    cve_id: string;
    user_id: number;
    created: number;
}
