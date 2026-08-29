import { z } from 'zod';

/**
 * A note's body is a list of typed blocks. A `number` block's visible index is
 * derived from its position in the run of consecutive `number` blocks (not
 * stored). Inline emphasis (bold `**`, italic `*`, underline `__`,
 * strikethrough `~~`) and text colour (`{c:name}…{/c}`) stay as markers inside
 * a block's `text`, not as separate blocks.
 */

/**
 * Named colour palette for inline text colour and the block-level `color` of
 * a marker (bullet dot, ordinal, checkbox, divider rule). Named rather than a
 * free hex so the stored value stays tied to a palette token (`--note-<name>`,
 * declared by the module's stylesheet). Widen this enum to add a colour.
 */
export const noteColorSchema = z.enum(['red', 'orange', 'yellow', 'green', 'blue', 'purple']);

export type NoteColor = z.infer<typeof noteColorSchema>;

export const noteTextBlockSchema = z.object({
    type: z.literal('text'),
    text: z.string()
});

export const noteCheckBlockSchema = z.object({
    type: z.literal('check'),
    text: z.string(),
    done: z.boolean(),
    color: noteColorSchema.optional()
});

export const noteBulletBlockSchema = z.object({
    type: z.literal('bullet'),
    text: z.string(),
    color: noteColorSchema.optional()
});

export const noteNumberBlockSchema = z.object({
    type: z.literal('number'),
    text: z.string(),
    color: noteColorSchema.optional()
});

export const noteHeadingBlockSchema = z.object({
    type: z.literal('heading'),
    text: z.string(),
    level: z.number().int().min(1).max(5)
});

export const noteDividerBlockSchema = z.object({
    type: z.literal('divider'),
    color: noteColorSchema.optional()
});

export const noteBlockSchema = z.discriminatedUnion('type', [
    noteTextBlockSchema,
    noteCheckBlockSchema,
    noteBulletBlockSchema,
    noteNumberBlockSchema,
    noteHeadingBlockSchema,
    noteDividerBlockSchema
]);

export type NoteTextBlock = z.infer<typeof noteTextBlockSchema>;
export type NoteCheckBlock = z.infer<typeof noteCheckBlockSchema>;
export type NoteBulletBlock = z.infer<typeof noteBulletBlockSchema>;
export type NoteNumberBlock = z.infer<typeof noteNumberBlockSchema>;
export type NoteHeadingBlock = z.infer<typeof noteHeadingBlockSchema>;
export type NoteDividerBlock = z.infer<typeof noteDividerBlockSchema>;
export type NoteBlock = z.infer<typeof noteBlockSchema>;

/** Upper bounds, enforced both client- and server-side, to keep rows sane. */
export const NOTE_TITLE_MAX_LENGTH = 200;
export const NOTE_FOLDER_MAX_LENGTH = 80;
export const NOTE_BLOCK_TEXT_MAX_LENGTH = 5_000;
export const NOTE_MAX_BLOCKS = 500;

/**
 * `name` is stored encrypted with the open key, so the folder tree is readable
 * without a password; only the linkage (`folderId` on notes) is in clear.
 */
export const noteFolderSchema = z.object({
    id: z.number().int().positive(),
    name: z.string().max(NOTE_FOLDER_MAX_LENGTH),
    /** Lower comes first. */
    sortOrder: z.number().int().nonnegative()
});

export type NoteFolder = z.infer<typeof noteFolderSchema>;

/**
 * Vrai pour une note projetée depuis un autre espace : elle se lit et s'édite
 * comme les autres (réécrite chez elle, sous sa clé), mais n'a ni dossier ni
 * rang ici (`folderId: null`, rangée à la racine après les locales), et ne
 * peut être ni détruite ni passée en privé depuis cette fenêtre.
 */
const foreign = z.boolean();

/**
 * A **private** note is encrypted with the password-wrapped DEK, so reading or
 * writing it requires the session to be unlocked; a regular note is encrypted
 * with the open key, which the server can always resolve: that's what lets the
 * feature open without any prompt, and what lets an ordinary note be projected
 * into another workspace while a private one never can.
 */
export const noteSchema = z.object({
    id: z.number().int().nonnegative(),
    title: z.string().max(NOTE_TITLE_MAX_LENGTH),
    folderId: z.number().int().positive().nullable(),
    blocks: z.array(noteBlockSchema).max(NOTE_MAX_BLOCKS),
    /** Rank within its folder; lower comes first. Only drag & drop changes it. */
    sortOrder: z.number().int().nonnegative(),
    private: z.boolean(),
    foreign,
    /** Epoch seconds. */
    updated: z.number().int().nonnegative(),
    created: z.number().int().nonnegative()
});

export type Note = z.infer<typeof noteSchema>;

/**
 * List variant. A private note listed while the session is locked comes back
 * **masked** (metadata only, no `title`/`preview`), the body never decrypted.
 */
export const noteSummarySchema = z.object({
    id: z.number().int().nonnegative(),
    title: z.string(),
    folderId: z.number().int().positive().nullable(),
    sortOrder: z.number().int().nonnegative(),
    /** Absent for masked notes. */
    preview: z.string().optional(),
    checkTotal: z.number().int().nonnegative(),
    checkDone: z.number().int().nonnegative(),
    private: z.boolean(),
    /** True when the body stayed encrypted for this response (private + locked). */
    masked: z.boolean(),
    foreign,
    /** Epoch seconds, or `null` while the note is active. */
    archivedAt: z.number().int().nonnegative().nullable(),
    updated: z.number().int().nonnegative(),
    created: z.number().int().nonnegative()
});

export type NoteSummary = z.infer<typeof noteSummarySchema>;

export interface NoteRow {
    id: number;
    user_id: number;
    /** L'espace qui détient la note : celui dont la clé la déchiffre. */
    workspace_id: number;
    folder_id: number | null;
    /** Encrypted JSON payload (title + blocks), keyed by the private DEK when `is_private`, by the open DEK otherwise. */
    content: string;
    sort_order: number;
    is_private: number;
    /** `NULL` while active. Only an archived note can be destroyed for good. */
    archived_at: number | null;
    updated: number;
    created: number;
}

export interface NoteFolderRow {
    id: number;
    user_id: number;
    workspace_id: number;
    /** Encrypted JSON payload (`{ name }`). */
    content: string;
    sort_order: number;
    created: number;
}
