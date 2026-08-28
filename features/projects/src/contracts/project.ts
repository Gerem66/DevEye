import { z } from 'zod';
import { projectStatusSchema, type ProjectStatus } from '@deveye/types';

/**
 * Projets : le suivi d'un travail, de ses premières phases à son déploiement.
 *
 * Découpage du stockage (voir `Docs/SECURITY_MODEL.md`). En **clair** tout ce
 * dont le serveur a besoin pour lister, trier, compter et router sans rien
 * déchiffrer — `workspace_id`, `status`, `security_tier`, `sort_order`, les
 * dates, `archived_at`. **Chiffré** tout ce qui identifie : titre, description,
 * étiquettes, version.
 *
 * Comme le mail, et contrairement à Uptime ou au coffre, l'étage de chiffrement
 * n'est pas fixé par la feature mais **choisi par projet** (`securityTier`) :
 * un projet `open` peut être synchronisé en tâche de fond (dépôt git,
 * déploiement) ; un projet `guarded` ne se déchiffre que pendant une session
 * vivante et déverrouillée, et perd donc ses intégrations automatiques.
 */

export const PROJECT_TITLE_MAX_LENGTH = 120;
export const PROJECT_DESCRIPTION_MAX_LENGTH = 4000;
export const PROJECT_VERSION_MAX_LENGTH = 40;
export const PROJECT_TAG_LABEL_MAX_LENGTH = 32;
export const PROJECT_MAX_TAGS = 24;

/**
 * Borne de l'icône d'un projet, en caractères de son URL de données.
 *
 * ~400 ko : de quoi loger confortablement une vignette carrée redimensionnée
 * par le client, sans laisser une charge utile WS grossir au gré de ce qu'on
 * dépose. L'icône vit **dans le payload chiffré** comme le titre : elle
 * identifie le projet autant qu'un nom, et un projet confidentiel ne doit pas
 * la laisser lire.
 */
export const PROJECT_ICON_MAX_LENGTH = 400_000;

/** Vide = icône par défaut. Sinon, une URL de données d'image. */
export const projectIconSchema = z
    .string()
    .max(PROJECT_ICON_MAX_LENGTH)
    .refine((v) => v === '' || /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(v), {
        message: 'L’icône doit être une image encodée en base64.'
    });

/** Quel coffre chiffre l'arbre du projet. Voir l'en-tête de ce fichier. */
export const projectSecurityTierSchema = z.enum(['open', 'guarded']);
export type ProjectSecurityTier = z.infer<typeof projectSecurityTierSchema>;

/**
 * D'où vient le numéro de version affiché.
 *  - `manual` — saisi à la main dans le profil du projet ;
 *  - `github_release` — la dernière release publiée du dépôt lié. Le champ
 *    devient alors en lecture seule dans l'interface, et un projet `guarded` ne
 *    peut pas le choisir (sa synchronisation de fond est impossible).
 */
export const projectVersionSourceSchema = z.enum(['manual', 'github_release']);
export type ProjectVersionSource = z.infer<typeof projectVersionSourceSchema>;

/**
 * Les deux familles d'étiquettes, cumulables sur un même projet :
 *  - `type` — ce que le projet *est* (app mobile, site web, service…) ;
 *  - `tech` — ce avec quoi il est fait (react, react native, express, vite…).
 *
 * Le libellé est libre plutôt qu'énuméré : une pile technique se renouvelle plus
 * vite qu'un schéma, et une valeur inconnue ne doit jamais faire disparaître un
 * projet de la liste. Les étiquettes voyagent **dans le payload chiffré** — le
 * filtrage se fait donc côté client, ce qui suffit largement à cette échelle.
 */
export const projectTagKindSchema = z.enum(['type', 'tech']);
export type ProjectTagKind = z.infer<typeof projectTagKindSchema>;

export const projectTagSchema = z.object({
    kind: projectTagKindSchema,
    label: z.string().min(1).max(PROJECT_TAG_LABEL_MAX_LENGTH)
});
export type ProjectTag = z.infer<typeof projectTagSchema>;

export const projectSchema = z.object({
    id: z.number().int().positive(),
    title: z.string().max(PROJECT_TITLE_MAX_LENGTH),
    /** Vignette du projet ; vide = l'icône par défaut de la feature. */
    icon: projectIconSchema,
    description: z.string().max(PROJECT_DESCRIPTION_MAX_LENGTH),
    tags: z.array(projectTagSchema).max(PROJECT_MAX_TAGS),
    version: z.string().max(PROJECT_VERSION_MAX_LENGTH),
    versionSource: projectVersionSourceSchema,
    status: projectStatusSchema,
    securityTier: projectSecurityTierSchema,
    /** Bornes de la fenêtre du projet, en secondes unix. Facultatives. */
    startDate: z.number().int().nullable(),
    dueDate: z.number().int().nullable(),
    sortOrder: z.number().int().nonnegative(),
    /**
     * Qui l'a créé : attribution, jamais une frontière d'accès. `null` quand le
     * compte a été supprimé depuis — un départ n'emporte pas le travail d'un
     * espace partagé (cf. `ON DELETE SET NULL` dans la migration).
     */
    authorUserId: z.number().int().positive().nullable(),
    archived: z.boolean(),
    created: z.number().int(),
    updated: z.number().int()
});
export type Project = z.infer<typeof projectSchema>;

/**
 * La ligne du portefeuille : le projet, plus ce que le serveur sait compter
 * **sans déchiffrer** (colonnes en clair uniquement).
 *
 * `masked: true` désigne un projet `guarded` dont le corps n'a pas pu être
 * déchiffré parce que la session est verrouillée. La ligne reste listée, avec
 * ses compteurs — on doit pouvoir voir qu'un projet existe, et le déverrouiller
 * en connaissance de cause, sans que la liste entière disparaisse. Même parti
 * pris que les notes privées.
 */
export const projectSummarySchema = z.object({
    project: projectSchema,
    masked: z.boolean(),
    /** Cartes actives (non archivées) et celles assises dans une colonne de fin. */
    cardTotal: z.number().int().nonnegative(),
    cardDone: z.number().int().nonnegative(),
    /** Cartes actives dont l'échéance est dépassée. */
    cardOverdue: z.number().int().nonnegative(),
    /** Prochaine échéance à venir, toutes cartes confondues. */
    nextDueDate: z.number().int().nullable(),
    /** Messages non lus par l'appelant sur tout le projet. */
    unread: z.number().int().nonnegative()
});
export type ProjectSummary = z.infer<typeof projectSummarySchema>;

/**
 * Ce que le client peut poser sur un projet. La version n'y est pas quand elle
 * est pilotée par les releases : `projects.setVersion` la traite à part, pour que
 * l'édition du profil ne puisse pas écraser en silence une valeur synchronisée.
 */
export const projectDraftSchema = z.object({
    title: z.string().min(1).max(PROJECT_TITLE_MAX_LENGTH),
    icon: projectIconSchema,
    description: z.string().max(PROJECT_DESCRIPTION_MAX_LENGTH),
    tags: z.array(projectTagSchema).max(PROJECT_MAX_TAGS),
    status: projectStatusSchema,
    startDate: z.number().int().nullable(),
    dueDate: z.number().int().nullable()
});
export type ProjectDraft = z.infer<typeof projectDraftSchema>;

/** Ligne SQL (serveur uniquement). `content` porte le payload chiffré. */
export interface ProjectRow {
    id: number;
    workspace_id: number;
    /** Auteur. En espace partagé il dit qui a créé la ligne, rien de plus. */
    user_id: number | null;
    status: ProjectStatus;
    security_tier: ProjectSecurityTier;
    version_source: ProjectVersionSource;
    sort_order: number;
    start_date: number | null;
    due_date: number | null;
    archived_at: number | null;
    content: string;
    created: number;
    updated: number;
}
