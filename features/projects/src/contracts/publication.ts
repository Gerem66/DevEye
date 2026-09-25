import { z } from 'zod';

import type { ProjectSecurityTier } from './project';

/**
 * La page publique d'un projet : son tableau, lisible sans compte, à un lien tiré
 * au hasard sous l'adresse de DevEye ou sous un domaine vérifié de son espace. Sur
 * un domaine, le plus ancien projet en ligne en tient la racine, les autres
 * répondent sous `/projet/<chemin>`.
 */

export const PUBLIC_PATH = '/projet';
export const PROJECT_SLUG_MAX_LENGTH = 48;
/** Minuscules, chiffres et tirets isolés, ni en tête ni en queue. */
export const PROJECT_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const projectSlugSchema = z
    .string()
    .max(PROJECT_SLUG_MAX_LENGTH)
    .regex(PROJECT_SLUG_PATTERN, 'Des minuscules, des chiffres et des tirets, sans espace ni accent.');

export const projectPublicationDraftSchema = z.object({
    enabled: z.boolean(),
    /** `null` : l'adresse de DevEye seule. */
    domainId: z.number().int().positive().nullable(),
    /** Le chemin sous le domaine ; `null` le tire du titre du projet. Ignoré sans domaine. */
    slug: projectSlugSchema.nullable(),
    /** Les échéances des cartes et leurs jalons. */
    showDates: z.boolean(),
    /** Les noms des membres assignés, lisibles par tous. */
    showAssignees: z.boolean()
});
export type ProjectPublicationDraft = z.infer<typeof projectPublicationDraftSchema>;

export const projectPublicationSchema = z.object({
    enabled: z.boolean(),
    domainId: z.number().int().positive().nullable(),
    slug: z.string().nullable(),
    showDates: z.boolean(),
    showAssignees: z.boolean(),
    /** L'adresse à donner : la racine du domaine, son chemin, ou le lien sous l'adresse de DevEye. */
    url: z.string(),
    /** Sous un domaine vérifié, le projet en tient la racine (ou la tiendrait une fois en ligne). */
    atRoot: z.boolean(),
    /** Le projet qui tient la racine du domaine quand ce n'est pas celui-ci. */
    rootTitle: z.string().nullable(),
    /** Au-delà de la limite de l'offre : la page répond « introuvable », sans que `enabled` ne bouge. */
    planPaused: z.boolean()
});
export type ProjectPublication = z.infer<typeof projectPublicationSchema>;

/** Pourquoi un projet ne se publie pas d'ici. */
export const projectPublicationBlockSchema = z.enum(['guarded', 'foreign']);
export type ProjectPublicationBlock = z.infer<typeof projectPublicationBlockSchema>;

/** Ligne SQL (serveur uniquement), l'espace et le palier lus sur `projects`. */
export interface ProjectPublicRow {
    project_id: number;
    workspace_id: number;
    security_tier: ProjectSecurityTier;
    public_ref: string;
    enabled: number;
    published_at: number | null;
    domain_id: number | null;
    slug: string | null;
    domain_at: number | null;
    show_dates: number;
    show_assignees: number;
    created: number;
}
