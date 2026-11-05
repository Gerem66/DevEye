import { userColorSchema } from '@deveye/types';
import { z } from 'zod';

export const WHITEBOARD_TITLE_MAX = 200;
/** Le JSON de la scène en clair : le même plafond pour toutes les offres. */
export const SCENE_MAX_BYTES = 8 * 1024 * 1024;
export const SCENE_MAX_ELEMENTS = 20_000;
/** Une image décodée : la limite qu'Excalidraw applique déjà à ce qu'on colle. */
export const FILE_MAX_BYTES = 4 * 1024 * 1024;
/** Un aperçu en data URL : une vignette, pas une exportation. */
export const PREVIEW_MAX_CHARS = 128 * 1024;
/** Ce qu'une réponse de `whiteboard.files` porte au plus, une image comprise quoi qu'il arrive. */
export const FILES_BATCH_CHARS = 4 * 1024 * 1024;
export const PUSH_MAX_ELEMENTS = 500;
export const ELEMENT_MAX_CHARS = 512 * 1024;
/** Un élément supprimé se garde ce temps pour qu'un pair en retard ne le ressuscite pas. */
export const TOMBSTONE_TTL_MS = 24 * 3_600_000;

export const fileMimeSchema = z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml']);
export type WhiteboardFileMime = z.infer<typeof fileMimeSchema>;

/** Un SHA-1 en hexadécimal par défaut, un nanoid sans contexte sécurisé. */
export const fileIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

export const boardIdSchema = z.number().int().positive();
export const clientIdSchema = z.uuid();

/**
 * Un élément de scène tel qu'Excalidraw le produit. Seuls les champs que la
 * fusion lit sont vérifiés ; le reste traverse tel quel, scellé avec la scène.
 */
export const sceneElementSchema = z.looseObject({
    id: z.string().min(1).max(64),
    type: z.string().min(1).max(32),
    version: z.number().int().min(1),
    versionNonce: z.number().int(),
    isDeleted: z.boolean(),
    index: z.string().max(256).nullable().optional(),
    updated: z.number(),
    fileId: fileIdSchema.nullable().optional()
});
export type SceneElement = z.infer<typeof sceneElementSchema>;

export const boardSummarySchema = z.object({
    id: z.number().int(),
    title: z.string(),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
    updatedBy: z.number().int().nullable(),
    /** Scène, aperçu et images : ce que le quota compte. */
    byteSize: z.number().int().nonnegative(),
    hasPreview: z.boolean(),
    /** Change à chaque aperçu enregistré : la grille ne relit que ceux qui ont bougé. */
    previewVersion: z.number().int().nonnegative(),
    /** Projeté depuis un autre espace. */
    foreign: z.boolean()
});
export type BoardSummary = z.infer<typeof boardSummarySchema>;

export const whiteboardUsageSchema = z.object({ used: z.number(), limit: z.number() }).nullable();

export const peerSchema = z.object({
    clientId: clientIdSchema,
    userId: z.number().int(),
    name: z.string(),
    color: userColorSchema,
    canWrite: z.boolean()
});
export type WhiteboardPeer = z.infer<typeof peerSchema>;

/** Une position dans les coordonnées de la scène, pas de l'écran. */
export const pointerSchema = z.object({
    x: z.number(),
    y: z.number(),
    tool: z.enum(['pointer', 'laser'])
});
export type WhiteboardPointer = z.infer<typeof pointerSchema>;

export const pointerButtonSchema = z.enum(['up', 'down']);

export const boardFileSchema = z.object({
    id: fileIdSchema,
    mimeType: fileMimeSchema,
    dataURL: z.string(),
    created: z.number().int()
});
export type BoardFile = z.infer<typeof boardFileSchema>;

// ── Les trames poussées aux participants d'une séance ─────────────────────

export const WHITEBOARD_ELEMENTS_EVENT = 'whiteboard.elements';
export const WHITEBOARD_POINTERS_EVENT = 'whiteboard.pointers';
export const WHITEBOARD_PEERS_EVENT = 'whiteboard.peers';
export const WHITEBOARD_SAVED_EVENT = 'whiteboard.saved';
export const WHITEBOARD_FILE_EVENT = 'whiteboard.fileAdded';
export const WHITEBOARD_CLOSED_EVENT = 'whiteboard.closed';

/** L'émetteur d'éléments venus de la base (un autre serveur) plutôt que d'un participant. */
export const SERVER_ORIGIN = '00000000-0000-4000-8000-000000000000';

/** Numérotée : un trou dit qu'une trame s'est perdue, et le client rejoint la séance. */
export const elementsFrameSchema = z.object({
    boardId: boardIdSchema,
    seq: z.number().int(),
    from: clientIdSchema,
    elements: z.array(sceneElementSchema)
});

export const pointersFrameSchema = z.object({
    boardId: boardIdSchema,
    clientId: clientIdSchema,
    pointer: pointerSchema.nullable(),
    button: pointerButtonSchema,
    selectedIds: z.array(z.string())
});

export const peersFrameSchema = z.object({ boardId: boardIdSchema, peers: z.array(peerSchema) });

export const savedFrameSchema = z.object({
    boardId: boardIdSchema,
    at: z.number().int(),
    /** `null` : écrit. Sinon la raison, que la pastille d'état dit. */
    failure: z.enum(['tooLarge', 'error']).nullable()
});

export const fileFrameSchema = z.object({ boardId: boardIdSchema, fileId: fileIdSchema });

export const closedFrameSchema = z.object({
    boardId: boardIdSchema,
    reason: z.enum(['removed', 'moved'])
});
