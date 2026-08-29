import { z } from 'zod';

/**
 * Le fil de discussion d'une carte. Seul le texte est chiffré sous l'étage du
 * projet ; l'auteur, l'horodatage et les mentions restent en colonnes claires, ce
 * qui permet de compter « mes mentions non lues » sans déchiffrer un message.
 */

export const PROJECT_MESSAGE_MAX_LENGTH = 4000;

export const PROJECT_MESSAGE_PAGE_SIZE = 60;

export const projectMessageSchema = z.object({
    id: z.number().int().positive(),
    cardId: z.number().int().positive(),
    /** `null` quand le compte a été supprimé depuis : le message, lui, reste. */
    authorUserId: z.number().int().positive().nullable(),
    text: z.string().max(PROJECT_MESSAGE_MAX_LENGTH),
    mentions: z.array(z.number().int().positive()),
    created: z.number().int(),
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
    /** Tableau JSON d'identifiants de membres. */
    mentions: string | null;
    created: number;
    edited: number | null;
    content: string;
}
