import { z } from 'zod';

import {
    boardFileSchema,
    boardIdSchema,
    boardSummarySchema,
    clientIdSchema,
    fileIdSchema,
    fileMimeSchema,
    peerSchema,
    pointerButtonSchema,
    pointerSchema,
    PREVIEW_MAX_CHARS,
    PUSH_MAX_ELEMENTS,
    SCENE_MAX_ELEMENTS,
    sceneElementSchema,
    whiteboardUsageSchema,
    WHITEBOARD_TITLE_MAX
} from './domain';

const title = z.string().trim().max(WHITEBOARD_TITLE_MAX);

/** Les tableaux de l'espace et ceux qui y sont projetés, sans leur scène. */
export const whiteboardList = {
    command: 'whiteboard.list' as const,
    input: z.object({}),
    output: z.object({ boards: z.array(boardSummarySchema), usage: whiteboardUsageSchema })
};

export const whiteboardCount = {
    command: 'whiteboard.count' as const,
    input: z.object({}),
    output: z.object({ count: z.number().int().nonnegative() })
};

/**
 * Un tableau neuf, vide ou importé d'un `.excalidraw`. `filesBytes` annonce les
 * images qui suivront (`fileAdd`), pour refuser l'import avant le premier envoi.
 */
export const whiteboardAdd = {
    command: 'whiteboard.add' as const,
    input: z.object({
        title,
        elements: z.array(sceneElementSchema).max(SCENE_MAX_ELEMENTS).optional(),
        filesBytes: z.number().int().nonnegative().optional()
    }),
    output: z.object({ board: boardSummarySchema })
};

export const whiteboardRename = {
    command: 'whiteboard.rename' as const,
    input: z.object({ boardId: boardIdSchema, title }),
    output: z.object({ board: boardSummarySchema })
};

/** Une copie dans l'espace actif, images comprises. */
export const whiteboardDuplicate = {
    command: 'whiteboard.duplicate' as const,
    input: z.object({ boardId: boardIdSchema }),
    output: z.object({ board: boardSummarySchema })
};

export const whiteboardRemove = {
    command: 'whiteboard.remove' as const,
    input: z.object({ boardId: boardIdSchema }),
    output: z.object({ boardId: boardIdSchema })
};

export const whiteboardPreviews = {
    command: 'whiteboard.previews' as const,
    input: z.object({ boardIds: z.array(boardIdSchema).max(50) }),
    output: z.object({ previews: z.array(z.object({ boardId: boardIdSchema, dataURL: z.string() })) })
};

export const whiteboardSetPreview = {
    command: 'whiteboard.setPreview' as const,
    input: z.object({
        boardId: boardIdSchema,
        dataURL: z
            .string()
            .max(PREVIEW_MAX_CHARS)
            .regex(/^data:image\/(png|webp);base64,[A-Za-z0-9+/]+=*$/)
    }),
    output: z.object({ boardId: boardIdSchema })
};

/** Idempotent : une image déjà là répond `created: false`. */
export const whiteboardFileAdd = {
    command: 'whiteboard.fileAdd' as const,
    input: z.object({
        boardId: boardIdSchema,
        fileId: fileIdSchema,
        mimeType: fileMimeSchema,
        dataURL: z.string()
    }),
    output: z.object({ fileId: fileIdSchema, created: z.boolean() })
};

/**
 * Des images par leur id. Au-delà du budget d'une réponse, le reste est dans
 * `more`, à redemander ; `missing` n'existe pas (ou plus) sur ce tableau.
 */
export const whiteboardFiles = {
    command: 'whiteboard.files' as const,
    input: z.object({ boardId: boardIdSchema, fileIds: z.array(fileIdSchema).max(500) }),
    output: z.object({
        files: z.array(boardFileSchema),
        missing: z.array(fileIdSchema),
        more: z.array(fileIdSchema)
    })
};

// ── La séance en direct ────────────────────────────────────────────────────

/** Entrer dans la séance du tableau : la scène telle que le serveur la tient. */
export const whiteboardJoin = {
    command: 'whiteboard.join' as const,
    input: z.object({ boardId: boardIdSchema, clientId: clientIdSchema }),
    output: z.object({
        seq: z.number().int(),
        title: z.string(),
        elements: z.array(sceneElementSchema),
        fileIds: z.array(fileIdSchema),
        peers: z.array(peerSchema),
        canWrite: z.boolean(),
        /** L'offre du propriétaire est pleine : seules les poussées qui n'agrandissent pas passent. */
        overQuota: z.boolean()
    })
};

export const whiteboardLeave = {
    command: 'whiteboard.leave' as const,
    input: z.object({ boardId: boardIdSchema, clientId: clientIdSchema }),
    output: z.object({})
};

/** Les éléments changés depuis le dernier envoi. Sans `mutates` : chaque trait relirait la liste chez tous. */
export const whiteboardPush = {
    command: 'whiteboard.push' as const,
    input: z.object({
        boardId: boardIdSchema,
        clientId: clientIdSchema,
        elements: z.array(sceneElementSchema).min(1).max(PUSH_MAX_ELEMENTS)
    }),
    output: z.object({
        seq: z.number().int(),
        accepted: z.number().int(),
        /** Ce qui agrandissait la scène a été écarté : l'offre est pleine, ou le tableau au plafond. */
        refused: z.enum(['quota', 'tooLarge']).nullable()
    })
};

/** Posté sans réponse attendue ; vaut aussi signe de vie toutes les quelques secondes. */
export const whiteboardPointer = {
    command: 'whiteboard.pointer' as const,
    input: z.object({
        boardId: boardIdSchema,
        clientId: clientIdSchema,
        pointer: pointerSchema.nullable(),
        button: pointerButtonSchema,
        selectedIds: z.array(z.string().max(64)).max(PUSH_MAX_ELEMENTS)
    }),
    output: z.object({})
};

export const whiteboardCommands = [
    whiteboardList,
    whiteboardCount,
    whiteboardAdd,
    whiteboardRename,
    whiteboardDuplicate,
    whiteboardRemove,
    whiteboardPreviews,
    whiteboardSetPreview,
    whiteboardFileAdd,
    whiteboardFiles,
    whiteboardJoin,
    whiteboardLeave,
    whiteboardPush,
    whiteboardPointer
] as const;
