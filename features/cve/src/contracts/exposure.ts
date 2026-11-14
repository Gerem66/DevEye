import { z } from 'zod';

import { cveSeveritySchema } from './domain';
import { formatIdSchema } from './formats';

/**
 * L'exposition de l'espace : ce qu'il fait tourner (l'inventaire, élément par
 * élément), et ce qui le touche (les constats).
 */

/** La feature d'où vient un élément suivi. */
export const exposureSourceSchema = z.enum(['git', 'device', 'database', 'deploy']);
export type ExposureSource = z.infer<typeof exposureSourceSchema>;

/** Où en est la lecture d'un élément : pas encore lu, lu, ou en échec à la dernière lecture. */
export const assetStatusSchema = z.enum(['pending', 'ok', 'error']);
export type AssetStatus = z.infer<typeof assetStatusSchema>;

/**
 * Ce qu'un constat signale : une faille publiée, une fin de vie, un paquet
 * que son auteur déprécie (ou qu'il ne maintient plus), une version majeure
 * de retard.
 */
export const findingKindSchema = z.enum(['vuln', 'eol', 'deprecated', 'outdated']);
export type FindingKind = z.infer<typeof findingKindSchema>;

/** Résolu : plus rien de l'espace n'est touché. Ignoré : une décision d'un membre. */
export const findingStateSchema = z.enum(['open', 'ignored', 'resolved']);
export type FindingState = z.infer<typeof findingStateSchema>;

/**
 * Un composant de l'inventaire. Un paquet vient d'un registre et se confronte
 * à OSV par son écosystème ; un produit est un logiciel que le NVD nomme
 * (nginx, PostgreSQL, Node).
 */
export const exposureComponentSchema = z.object({
    kind: z.enum(['package', 'product']),
    /** L'écosystème OSV d'un paquet (`npm`, `crates.io`), l'outil d'un produit (`nginx`). */
    ecosystem: z.string().max(40),
    name: z.string().max(300),
    version: z.string().max(100),
    format: formatIdSchema,
    path: z.string().max(500).nullable(),
    line: z.number().int().positive().nullable(),
    /**
     * `false` : une étiquette flottante (`postgres:13`) ne dit que la branche.
     * Elle suffit à la fin de vie, jamais à une faille. Absent : exacte.
     */
    exact: z.boolean().optional(),
    /** Déclarée par un manifeste du dépôt, pas seulement tirée par une autre. */
    direct: z.boolean().optional()
});
export type ExposureComponent = z.infer<typeof exposureComponentSchema>;

/** Ce que les catalogues disent d'un composant, pour l'inventaire. */
export const componentNotesSchema = z.object({
    /** La fin de vie de sa branche, quand endoflife.date la connaît. */
    eol: z.object({ release: z.string(), date: z.string().nullable(), reached: z.boolean() }).nullable(),
    /** La dernière version publiée, pour une dépendance directe que deps.dev connaît. */
    latest: z.string().nullable(),
    deprecated: z.boolean()
});
export type ComponentNotes = z.infer<typeof componentNotesSchema>;

/** Un format trouvé dans un élément, et combien de composants il a donnés. */
export const assetFormatSchema = z.object({
    format: formatIdSchema,
    path: z.string().max(500).nullable(),
    count: z.number().int().nonnegative()
});
export type AssetFormat = z.infer<typeof assetFormatSchema>;

/** Un élément suivi, tel que l'inventaire le liste. */
export const exposureAssetSchema = z.object({
    id: z.number().int().positive(),
    source: exposureSourceSchema,
    /** L'identifiant de l'élément chez sa feature. */
    ref: z.string().max(64),
    label: z.string(),
    status: assetStatusSchema,
    error: z.string().nullable(),
    excluded: z.boolean(),
    /** Dernière fois que la source a été consultée, même pour n'y rien trouver de neuf. */
    checkedAt: z.number().int().nonnegative().nullable(),
    /** Dernière lecture complète de l'élément. */
    scannedAt: z.number().int().nonnegative().nullable(),
    formats: z.array(assetFormatSchema),
    componentCount: z.number().int().nonnegative(),
    /** Ce que la dernière lecture n'a pas pu couvrir, en phrases. */
    notes: z.array(z.string()),
    openFindings: z.number().int().nonnegative()
});
export type ExposureAsset = z.infer<typeof exposureAssetSchema>;

/** Un élément touché par un constat, avec ce qui, en lui, est touché. */
export const affectedAssetSchema = z.object({
    assetId: z.number().int().positive(),
    source: exposureSourceSchema,
    ref: z.string().max(64),
    label: z.string(),
    version: z.string(),
    path: z.string().nullable(),
    line: z.number().int().positive().nullable(),
    /** Les projets qui relient l'élément, quand il y en a. */
    projects: z.array(z.object({ id: z.number().int().positive(), title: z.string() }))
});
export type AffectedAsset = z.infer<typeof affectedAssetSchema>;

export const exposureFindingSchema = z.object({
    id: z.number().int().positive(),
    kind: findingKindSchema,
    state: findingStateSchema,
    /** L'identifiant public : la CVE quand il y en a une, l'avis OSV sinon. */
    advisoryId: z.string().nullable(),
    severity: cveSeveritySchema,
    score: z.number().min(0).max(10).nullable(),
    title: z.string(),
    summary: z.string(),
    /** Ce qui est touché, nommé comme son registre ou le NVD le nomme. */
    subject: z.object({ kind: z.enum(['package', 'product']), ecosystem: z.string(), name: z.string() }),
    /** Les versions qui corrigent, quand l'avis en nomme. */
    fixed: z.array(z.string()),
    reference: z.string().nullable(),
    aliases: z.array(z.string()),
    firstSeen: z.number().int().nonnegative(),
    lastSeen: z.number().int().nonnegative(),
    resolvedAt: z.number().int().nonnegative().nullable(),
    ignoredAt: z.number().int().nonnegative().nullable(),
    ignoredBy: z.number().int().nullable(),
    reason: z.string().nullable(),
    affected: z.array(affectedAssetSchema)
});
export type ExposureFinding = z.infer<typeof exposureFindingSchema>;

/** Ce que la carte de l'accueil compte : les constats ouverts que le membre peut voir. */
export const exposureCountsSchema = z.object({
    /** Les failles ouvertes : le chiffre de la carte. */
    count: z.number().int().nonnegative(),
    critical: z.number().int().nonnegative(),
    high: z.number().int().nonnegative(),
    eol: z.number().int().nonnegative(),
    deprecated: z.number().int().nonnegative(),
    outdated: z.number().int().nonnegative(),
    /** Les éléments lus au moins une fois : zéro faille sur rien d'analysé ne veut rien dire. */
    scanned: z.number().int().nonnegative()
});
export type ExposureCounts = z.infer<typeof exposureCountsSchema>;

/** À partir de quelle gravité une faille neuve envoie une alerte. `all` compte aussi les failles non qualifiées. */
export const alertThresholdSchema = z.enum(['critical', 'high', 'medium', 'all']);
export type AlertThreshold = z.infer<typeof alertThresholdSchema>;

/**
 * Ce que l'espace règle de sa veille : quelles alertes partent, chacune
 * indépendamment des autres.
 */
export const exposurePrefsSchema = z.object({
    /** Les sources que la veille lit ; une source coupée ne compte plus nulle part. */
    sources: z.object({ git: z.boolean(), device: z.boolean(), database: z.boolean(), deploy: z.boolean() }),
    alerts: z.object({
        vuln: z.boolean(),
        eol: z.boolean(),
        deprecated: z.boolean(),
        /** Coupé d'office : chaque version majeure d'une dépendance directe le déclencherait dans chaque dépôt. */
        outdated: z.boolean()
    }),
    threshold: alertThresholdSchema
});
export type ExposurePrefs = z.infer<typeof exposurePrefsSchema>;

export const DEFAULT_EXPOSURE_PREFS: ExposurePrefs = {
    sources: { git: true, device: true, database: true, deploy: true },
    alerts: { vuln: true, eol: true, deprecated: true, outdated: false },
    threshold: 'high'
};
