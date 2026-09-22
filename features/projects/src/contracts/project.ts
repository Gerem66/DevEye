import { z } from 'zod';
import { projectStatusSchema, type ProjectStatus } from '@deveye/types';

/**
 * Projets : le suivi d'un travail, de ses premières phases à son déploiement. Reste
 * en clair ce qui sert à lister, trier, compter et router sans déchiffrer (espace,
 * statut, palier, rang, dates) ; tout ce qui identifie est chiffré. L'étage de
 * chiffrement n'est pas fixé par la feature mais choisi par projet
 * (`securityTier`) : un projet `open` se synchronise en tâche de fond, un projet
 * `guarded` ne se déchiffre qu'en session déverrouillée et perd ces automatismes.
 */

export const PROJECT_TITLE_MAX_LENGTH = 120;
export const PROJECT_DESCRIPTION_MAX_LENGTH = 4000;
export const PROJECT_VERSION_MAX_LENGTH = 40;
export const PROJECT_TAG_LABEL_MAX_LENGTH = 32;
export const PROJECT_MAX_TAGS = 24;

/**
 * Borne de l'icône, en caractères de son URL de données : de quoi loger une
 * vignette redimensionnée par le client sans laisser grossir la charge utile WS.
 * L'icône vit dans le payload chiffré, elle identifie le projet autant qu'un nom.
 */
export const PROJECT_ICON_MAX_LENGTH = 400_000;

/** Vide = icône par défaut. */
export const projectIconSchema = z
    .string()
    .max(PROJECT_ICON_MAX_LENGTH)
    .refine((v) => v === '' || /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(v), {
        message: 'L’icône doit être une image encodée en base64.'
    });

/** Quel coffre chiffre l'arbre du projet. */
export const projectSecurityTierSchema = z.enum(['open', 'guarded']);
export type ProjectSecurityTier = z.infer<typeof projectSecurityTierSchema>;

/**
 * D'où vient le numéro de version affiché. Sous `github_release`, la dernière
 * release publiée du dépôt lié : le champ passe en lecture seule, et un projet
 * `guarded` ne peut pas le choisir faute de synchronisation de fond.
 */
export const projectVersionSourceSchema = z.enum(['manual', 'github_release']);
export type ProjectVersionSource = z.infer<typeof projectVersionSourceSchema>;

/**
 * Les deux familles d'étiquettes, cumulables : ce que le projet est (`type`) et ce
 * avec quoi il est fait (`tech`). Le libellé reste libre, une pile technique se
 * renouvelle plus vite qu'un schéma. Les étiquettes voyageant dans le payload
 * chiffré, le filtrage se fait côté client.
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
    icon: projectIconSchema,
    description: z.string().max(PROJECT_DESCRIPTION_MAX_LENGTH),
    tags: z.array(projectTagSchema).max(PROJECT_MAX_TAGS),
    version: z.string().max(PROJECT_VERSION_MAX_LENGTH),
    versionSource: projectVersionSourceSchema,
    status: projectStatusSchema,
    securityTier: projectSecurityTierSchema,
    /**
     * L'onglet « Vue d'ensemble » paraît-il dans la barre ? Au projet et non à son
     * lecteur. En clair : la barre se dessine avant tout déchiffrement.
     */
    showOverview: z.boolean(),
    /** Idem pour la Frise. Le Tableau, lui, ne se retire pas : c'est la vue d'arrivée. */
    showTimeline: z.boolean(),
    /** Bornes de la fenêtre du projet, en secondes unix. */
    startDate: z.number().int().nullable(),
    dueDate: z.number().int().nullable(),
    sortOrder: z.number().int().nonnegative(),
    /**
     * Attribution, jamais une frontière d'accès. `null` quand le compte a été
     * supprimé depuis : un départ n'emporte pas le travail d'un espace partagé.
     */
    authorUserId: z.number().int().positive().nullable(),
    archived: z.boolean(),
    /**
     * Vrai quand le projet vit dans un autre espace qui le projette ici
     * (`Docs/SHARING.md`). Tout son arbre se lit et s'écrit chez lui, sous la clé de
     * son espace d'origine ; ce qui référence d'autres objets de cet espace
     * (liaisons, palier, suivi des releases, classement) se règle là-bas, le serveur
     * le refuse d'ici et l'écran ne le propose pas.
     */
    foreign: z.boolean(),
    created: z.number().int(),
    updated: z.number().int()
});
export type Project = z.infer<typeof projectSchema>;

/**
 * La ligne du portefeuille : le projet, plus ce que le serveur sait compter sans
 * déchiffrer. `masked` désigne un projet `guarded` que la session verrouillée n'a
 * pas pu ouvrir ; la ligne reste listée avec ses compteurs, pour qu'on puisse le
 * déverrouiller en connaissance de cause plutôt que le voir disparaître.
 */
export const projectSummarySchema = z.object({
    project: projectSchema,
    masked: z.boolean(),
    /**
     * Le même drapeau que `project.foreign`, relevé sur la ligne comme `masked` : le
     * portefeuille range et filtre ses lignes sans ouvrir le projet.
     */
    foreign: z.boolean(),
    /** Cartes actives (non archivées) et celles assises dans une colonne de fin. */
    cardTotal: z.number().int().nonnegative(),
    cardDone: z.number().int().nonnegative(),
    /** Cartes actives dont l'échéance est dépassée. */
    cardOverdue: z.number().int().nonnegative(),
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
    showOverview: z.boolean(),
    showTimeline: z.boolean(),
    startDate: z.number().int().nullable(),
    dueDate: z.number().int().nullable()
});
export type ProjectDraft = z.infer<typeof projectDraftSchema>;

/** Ligne SQL (serveur uniquement). `content` porte le payload chiffré. */
export interface ProjectRow {
    id: number;
    workspace_id: number;
    user_id: number | null;
    status: ProjectStatus;
    security_tier: ProjectSecurityTier;
    version_source: ProjectVersionSource;
    show_overview: number;
    show_timeline: number;
    sort_order: number;
    start_date: number | null;
    due_date: number | null;
    archived_at: number | null;
    content: string;
    created: number;
    updated: number;
}
