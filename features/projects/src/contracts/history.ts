import { z } from 'zod';

/**
 * L'historique d'un projet : la mémoire de ce qui lui est arrivé, pas un journal
 * technique (celui-là existe déjà, c'est l'audit). Le type, l'auteur, l'horodatage
 * et la référence à l'objet restent en clair pour trier et router sans clé ; le
 * libellé et le avant/après sont chiffrés.
 */

export const PROJECT_EVENT_LABEL_MAX_LENGTH = 200;
export const PROJECT_EVENT_PAGE_SIZE = 50;

/**
 * Ce qui mérite d'entrer dans l'histoire d'un projet. Volontairement court : une
 * frise qui consigne tout ne se lit plus, le va-et-vient quotidien des cartes entre
 * colonnes n'y figure pas.
 */
export const projectEventKindSchema = z.enum([
    'projects.created',
    'projects.renamed',
    'projects.version',
    'projects.status',
    'projects.securityTier',
    'projects.archived',
    'projects.restored',
    'card.archived',
    'card.restored',
    'milestone.reached',
    'deploy.triggered',
    'deploy.succeeded',
    'deploy.failed'
]);
export type ProjectEventKind = z.infer<typeof projectEventKindSchema>;

/** Ce que la référence désigne, pour que la frise sache quoi ouvrir. */
export const projectEventRefSchema = z.enum(['card', 'milestone']);
export type ProjectEventRef = z.infer<typeof projectEventRefSchema>;

export const projectEventSchema = z.object({
    id: z.number().int().positive(),
    projectId: z.number().int().positive(),
    /** `null` = une tâche de fond, ou un compte supprimé depuis. */
    actorUserId: z.number().int().positive().nullable(),
    /**
     * Un type inconnu ne fait pas disparaître la ligne : un client plus ancien que
     * le serveur doit pouvoir lire la frise, quitte à afficher une entrée générique.
     */
    kind: projectEventKindSchema.catch('projects.status'),
    refType: projectEventRefSchema.nullable(),
    refId: z.number().int().positive().nullable(),
    label: z.string().max(PROJECT_EVENT_LABEL_MAX_LENGTH),
    /** Avant / après, quand le changement en a un (renommage, version, statut). */
    from: z.string().max(PROJECT_EVENT_LABEL_MAX_LENGTH).nullable(),
    to: z.string().max(PROJECT_EVENT_LABEL_MAX_LENGTH).nullable(),
    created: z.number().int()
});
export type ProjectEvent = z.infer<typeof projectEventSchema>;

/** Ligne SQL (serveur uniquement). */
export interface ProjectEventRow {
    id: number;
    project_id: number;
    workspace_id: number;
    actor_user_id: number | null;
    kind: string;
    ref_type: string | null;
    ref_id: number | null;
    created: number;
    content: string;
}
