import { z } from 'zod';
import { projectCardSchema } from './board';

/**
 * Ce qui relie un projet au reste de DevEye, et une personne à ses tâches à travers
 * tous les projets. Une liaison ne stocke qu'un identifiant : l'objet visé garde
 * ses propres droits, c'est la feature qui le détient qui tranche.
 */

/**
 * Une tâche qui m'est attribuée, vue depuis l'extérieur de son projet. `masked`
 * marque une carte d'un projet confidentiel verrouillé : comptée et située, titre
 * illisible. La faire disparaître donnerait une liste de tâches fausse.
 */
export const myTaskSchema = z.object({
    card: projectCardSchema,
    projectId: z.number().int().positive(),
    projectTitle: z.string(),
    masked: z.boolean()
});
export type MyTask = z.infer<typeof myTaskSchema>;

/**
 * L'intitulé d'un objet d'espace relié, tel que la feature visée le rend par son
 * contrat d'éléments (`labelOf`). Une entrée par identifiant lié, toujours ; `label`
 * vaut `null` quand le module est absent ou que l'élément a disparu, et l'écran
 * montre « un élément disparu », jamais un numéro. Seul le nom voyage jusqu'à une
 * fenêtre sur le projet : ouvrir l'objet reste un droit de l'espace d'origine.
 */
export const projectLinkLabelSchema = z.object({
    id: z.number().int().positive(),
    label: z.string().nullable()
});
export type ProjectLinkLabel = z.infer<typeof projectLinkLabelSchema>;

/**
 * Combien d'éléments chaque intégration d'un projet a à montrer : zéro fait
 * disparaître l'onglet. Les clés portent le nom de la feature d'espace pointée et
 * non celui de l'onglet, ce sont les mêmes identifiants que les droits
 * (`workspaceFeatureIdSchema`). Un compte ne dit rien du droit de lire le contenu :
 * les liaisons relèvent de Projets, ce qu'elles pointent de la feature visée.
 */
export const projectLinkCountsSchema = z.object({
    git: z.number().int().nonnegative(),
    database: z.number().int().nonnegative(),
    audience: z.number().int().nonnegative(),
    deploy: z.number().int().nonnegative(),
    uptime: z.number().int().nonnegative()
});
export type ProjectLinkCounts = z.infer<typeof projectLinkCountsSchema>;

/**
 * Ligne SQL (serveur uniquement) : la liaison projet → service surveillé, non
 * exclusive dans les deux sens, comme toutes les liaisons vers un objet d'espace.
 */
export interface ProjectUptimeLinkRow {
    project_id: number;
    service_id: number;
    workspace_id: number;
    created: number;
}

/**
 * Ligne SQL (serveur uniquement) : la liaison projet → base. La table appartient à
 * Projets, pas au module Bases de données, qui ne connaît ses projets que par le
 * contrat `PROJECTS_USAGE_PROVIDER`.
 */
export interface ProjectDatabaseLinkRow {
    project_id: number;
    database_id: number;
    workspace_id: number;
    created: number;
}

/** Ligne SQL (serveur uniquement) : la liaison projet → cible. */
export interface ProjectDeployLinkRow {
    project_id: number;
    target_id: number;
    workspace_id: number;
    created: number;
}

export interface ProjectRepoLinkRow {
    project_id: number;
    workspace_id: number;
    repo_id: number;
    created: number;
}

export interface ProjectAudienceLinkRow {
    project_id: number;
    site_id: number;
    workspace_id: number;
    created: number;
}
