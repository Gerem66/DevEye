import { z } from 'zod';

/**
 * Le fil de discussion d'une carte.
 *
 * Découpage clair / chiffré, comme le reste du module : le **texte** est
 * chiffré sous l'étage du projet ; l'auteur, l'horodatage et les mentions
 * restent en colonnes claires.
 *
 * Les mentions en clair, c'est délibéré : ce sont des identifiants de membres
 * de l'espace, que le serveur connaît déjà par `workspace_members`. Les garder
 * lisibles est ce qui permet de compter « mes mentions non lues » sans
 * déchiffrer un seul message.
 */

export const PROJECT_MESSAGE_MAX_LENGTH = 4000;

/** Combien de messages une page de fil rend au plus. */
export const PROJECT_MESSAGE_PAGE_SIZE = 60;

export const projectMessageSchema = z.object({
    id: z.number().int().positive(),
    cardId: z.number().int().positive(),
    /** `null` quand le compte a été supprimé depuis : le message, lui, reste. */
    authorUserId: z.number().int().positive().nullable(),
    text: z.string().max(PROJECT_MESSAGE_MAX_LENGTH),
    mentions: z.array(z.number().int().positive()),
    created: z.number().int(),
    /** Horodatage de la dernière retouche, ou `null` si jamais modifié. */
    edited: z.number().int().nullable()
});
export type ProjectMessage = z.infer<typeof projectMessageSchema>;

/** Ligne SQL (serveur uniquement). */
export interface ProjectMessageRow {
    id: number;
    card_id: number;
    project_id: number;
    workspace_id: number;
    author_user_id: number | null;
    /** Tableau JSON d'identifiants de membres, ou `null`. */
    mentions: string | null;
    created: number;
    edited: number | null;
    content: string;
}
