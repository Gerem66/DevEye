import { pageAccentSchema, pageThemeChoiceSchema, type PageTheme, type PageThemeChoice } from '@deveye/types/sdk';
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

/**
 * Les couleurs du tableau public, par thème. La page les pose en jetons, la
 * vignette de ses réglages les reprend : elle vit hors de l'app, sans ses jetons.
 */
export const PUBLIC_BOARD_PALETTE: Readonly<Record<PageTheme, Readonly<Record<string, string>>>> = {
    light: {
        bg: '#f5f6f8',
        column: '#eceef2',
        card: '#ffffff',
        ink: '#15171c',
        muted: '#5e6573',
        line: '#e3e6eb',
        accent: '#3a6ad6',
        normal: '#3a6ad6',
        low: '#1c9a52',
        high: '#d23f3f',
        late: '#c23434',
        'late-soft': '#fbe9e9',
        chip: '#eef0f3',
        'dot-ring': 'rgba(21, 23, 28, 0.18)',
        'avatar-ink': '#15171c',
        shadow: '0 1px 2px rgba(21, 23, 28, 0.06)'
    },
    dark: {
        bg: '#0e1015',
        column: '#14171d',
        card: '#1b1f27',
        ink: '#e8eaef',
        muted: '#9aa2b1',
        line: '#2a303b',
        accent: '#6f9bff',
        normal: '#6f9bff',
        low: '#30bd6a',
        high: '#ee5858',
        late: '#ff7b7b',
        'late-soft': '#331a1c',
        chip: '#242a33',
        'dot-ring': 'rgba(232, 234, 239, 0.16)',
        'avatar-ink': '#15171c',
        shadow: 'none'
    }
};

/** L'accent du tableau quand aucun n'est choisi, par thème. */
export const PUBLIC_OWN_ACCENT: Readonly<Record<PageTheme, string>> = {
    light: PUBLIC_BOARD_PALETTE.light.accent,
    dark: PUBLIC_BOARD_PALETTE.dark.accent
};

export const PUBLIC_THEMES: readonly PageThemeChoice[] = ['auto', 'light', 'dark'];

export const projectPublicationDraftSchema = z.object({
    enabled: z.boolean(),
    /** `null` : l'adresse de DevEye seule. */
    domainId: z.number().int().positive().nullable(),
    /** Le chemin sous le domaine ; `null` le tire du titre du projet. Ignoré sans domaine. */
    slug: projectSlugSchema.nullable(),
    /** Les échéances des cartes et leurs jalons. */
    showDates: z.boolean(),
    /** Les noms des membres assignés, lisibles par tous. */
    showAssignees: z.boolean(),
    /** Un clic sur une carte déplie ses sous-tâches. */
    showSubtasks: z.boolean(),
    theme: pageThemeChoiceSchema,
    accent: pageAccentSchema
});
export type ProjectPublicationDraft = z.infer<typeof projectPublicationDraftSchema>;

export const projectPublicationSchema = z.object({
    enabled: z.boolean(),
    domainId: z.number().int().positive().nullable(),
    slug: z.string().nullable(),
    showDates: z.boolean(),
    showAssignees: z.boolean(),
    showSubtasks: z.boolean(),
    theme: pageThemeChoiceSchema,
    accent: z.string(),
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
    show_subtasks: number;
    theme: string;
    accent: string;
    created: number;
}
