import { MODERATION_REASONS, type ModerationReason } from '@deveye/types/sdk';
import { z } from 'zod';

/**
 * Le vocabulaire : une _règle_ interdit soit une _empreinte_ (le SHA-256 d'un
 * contenu), soit un _motif de nom_ ; une _détection_ est un fichier qu'une
 * règle a arrêté quelque part.
 */

export const RULE_LABEL_MAX = 200;
export const NAME_PATTERN_MAX = 255;
/** Un texte collé de motifs, un par ligne : au-delà, c'est une liste externe (`MODERATION_FEED_URL`). */
export const RULES_TEXT_MAX = 2_000_000;
export const HITS_LIMIT_MAX = 500;

export const ruleKindSchema = z.enum(['fingerprint', 'name']);
export type RuleKind = z.infer<typeof ruleKindSchema>;

export const moderationReasonSchema = z.enum(MODERATION_REASONS);

export const MODERATION_REASON_LABELS: Readonly<Record<ModerationReason, string>> = {
    illegal: 'Contenu illicite',
    copyright: 'Atteinte au droit d’auteur ou à une marque',
    malware: 'Logiciel malveillant ou hameçonnage',
    privacy: 'Atteinte à la vie privée ou données personnelles',
    minors: 'Contenu mettant en danger des mineurs',
    other: 'Autre motif'
};

/** `public` : les pages ouvertes à tous ; `everywhere` : aussi ce qu'un compte garde pour lui et ses appareils. */
export const ruleExposureSchema = z.enum(['public', 'everywhere']);
export type RuleExposure = z.infer<typeof ruleExposureSchema>;

export const RULE_EXPOSURE_LABELS: Readonly<Record<RuleExposure, string>> = {
    public: 'Pages publiques seulement',
    everywhere: 'Partout, stockage privé compris'
};

/** D'où vient la règle : posée par un modérateur, tirée d'un retrait, ou de la liste externe. */
export const ruleSourceSchema = z.enum(['manual', 'takedown', 'feed']);
export type RuleSource = z.infer<typeof ruleSourceSchema>;

export const RULE_SOURCE_LABELS: Readonly<Record<RuleSource, string>> = {
    manual: 'saisie',
    takedown: 'retrait',
    feed: 'liste externe'
};

export const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export const fingerprintSchema = z
    .string()
    .trim()
    .toLowerCase()
    .regex(SHA256_PATTERN, 'Une empreinte est un SHA-256 : 64 caractères hexadécimaux.');

/** Un motif de nom : des jokers `*` et `?`, jamais de séparateur, et au moins un caractère qui n'est pas un joker. */
export const namePatternSchema = z
    .string()
    .trim()
    .min(1, 'Un motif est nécessaire.')
    .max(NAME_PATTERN_MAX, `${NAME_PATTERN_MAX} caractères au plus.`)
    .refine((value) => !/[/\\]/.test(value), 'Un motif porte sur le nom seul, sans barre oblique.')
    .refine((value) => /[^*?]/.test(value), 'Un motif fait de jokers seuls arrêterait tout.');

export const ruleSchema = z.object({
    id: z.number().int(),
    kind: ruleKindSchema,
    pattern: z.string(),
    reason: moderationReasonSchema,
    label: z.string(),
    exposure: ruleExposureSchema,
    source: ruleSourceSchema,
    hits: z.number().int(),
    lastHit: z.number().int().nullable(),
    created: z.number().int()
});
export type Rule = z.infer<typeof ruleSchema>;

/**
 * Ce que les règles d'un ajout ont en commun. `label` vide : la personne
 * arrêtée lit le libellé du motif (« Logiciel malveillant ou hameçonnage »).
 */
export const rulesDraftSchema = z.object({
    kind: ruleKindSchema,
    /** Les motifs, un par ligne ; les lignes vides et celles en `#` sont ignorées. */
    text: z.string().max(RULES_TEXT_MAX),
    reason: moderationReasonSchema,
    label: z.string().trim().max(RULE_LABEL_MAX),
    exposure: ruleExposureSchema
});
export type RulesDraft = z.infer<typeof rulesDraftSchema>;

/** Ce que lit la personne arrêtée : le libellé de la règle, ou celui de son motif. */
export function ruleLabelOf(label: string, reason: ModerationReason): string {
    const own = label.trim();
    return own.length > 0 ? own : MODERATION_REASON_LABELS[reason];
}

/** La liste externe d'empreintes, telle que la page la décrit. */
export const feedStatusSchema = z.object({
    configured: z.boolean(),
    /** Les empreintes qu'elle a apportées, toutes importations confondues. */
    count: z.number().int(),
    lastImport: z.number().int().nullable(),
    lastError: z.string().nullable()
});
export type FeedStatus = z.infer<typeof feedStatusSchema>;

export const hitSchema = z.object({
    id: z.number().int(),
    /** L'id de la fonctionnalité qui a consulté (`x-hosting`, `cloudsync`). */
    feature: z.string(),
    ruleId: z.number().int().nullable(),
    kind: ruleKindSchema,
    reason: moderationReasonSchema,
    label: z.string(),
    /** Le nom du fichier et l'élément qui le portait, ouverts par le serveur. */
    name: z.string(),
    context: z.string(),
    sha256: z.string().nullable(),
    size: z.number().int().nullable(),
    /** L'espace et le compte d'origine : `null` pour un modérateur, qui juge le contenu sans savoir d'où il vient. */
    workspaceId: z.number().int().nullable(),
    userId: z.number().int().nullable(),
    /** Le même fichier arrêté plusieurs fois (un appareil qui réessaie) tient sur une ligne. */
    count: z.number().int(),
    firstSeen: z.number().int(),
    lastSeen: z.number().int()
});
export type Hit = z.infer<typeof hitSchema>;
