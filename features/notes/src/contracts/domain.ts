import { z } from 'zod';

/**
 * A note's body is a modular list of typed blocks rather than free text. This
 * keeps the editor "à la Apple" (one clean surface) while still supporting
 * paragraphs and checklists in any order:
 *  - `text`  → a paragraph.
 *  - `check` → a checklist item, with its own `done` state.
 *
 *  - `bullet` → a bulleted (unordered) list item.
 *  - `number` → a numbered (ordered) list item; its visible index is derived
 *    from its position in the run of consecutive `number` blocks (not stored).
 *  - `heading` → a section title, `level` 1 (largest) to 5 (smallest).
 *  - `divider` → a horizontal separator; carries no text.
 *
 * Inline emphasis (bold `**`, italic `*`, underline `__`, strikethrough `~~`)
 * is kept as markdown markers inside a block's `text`, not as separate blocks.
 *
 * The shape is intentionally small and forward-compatible: adding a new block
 * kind later (heading, divider, ...) only widens this union.
 */
/**
 * Named colour palette shared by the two colouring features:
 *  - inline text colour, carried as `{c:name}…{/c}` markers inside a block's
 *    `text` (so it lives in the freeform string, not the schema);
 *  - the block-level `color` below, which tints a marker (bullet dot, ordinal,
 *    checkbox, divider rule).
 *
 * A *named* palette (not a free hex) keeps the stored value tied to a palette
 * token (`--note-<name>`, declared by the module's own stylesheet), so colours
 * stay coherent with the app's design and adapt if the palette is retuned.
 * Widen this enum to add a colour.
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
    /** Optional tint for the checkbox marker (palette token `--note-<color>`). */
    color: noteColorSchema.optional()
});

export const noteBulletBlockSchema = z.object({
    type: z.literal('bullet'),
    text: z.string(),
    /** Optional tint for the bullet dot (palette token `--note-<color>`). */
    color: noteColorSchema.optional()
});

export const noteNumberBlockSchema = z.object({
    type: z.literal('number'),
    text: z.string(),
    /** Optional tint for the ordinal marker (palette token `--note-<color>`). */
    color: noteColorSchema.optional()
});

export const noteHeadingBlockSchema = z.object({
    type: z.literal('heading'),
    text: z.string(),
    /** Heading level, 1 (largest) to 5 (smallest). */
    level: z.number().int().min(1).max(5)
});

export const noteDividerBlockSchema = z.object({
    type: z.literal('divider'),
    /** Optional tint for the horizontal rule (palette token `--note-<color>`). */
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
 * A folder is a first-class, server-persisted bucket. Its `name` is stored
 * encrypted server-side (with the open key, so the folder tree is readable
 * without a password); only the linkage (`folderId` on notes) is kept in clear.
 * `id` is stable across renames, so notes reference it directly.
 */
export const noteFolderSchema = z.object({
    id: z.number().int().positive(),
    name: z.string().max(NOTE_FOLDER_MAX_LENGTH),
    /** Rank within the user's folders; lower comes first. Manually reorderable. */
    sortOrder: z.number().int().nonnegative()
});

export type NoteFolder = z.infer<typeof noteFolderSchema>;

/**
 * A full note as exchanged with the client. `folderId` references a
 * {@link noteFolderSchema}; `null` means "no folder" (Sans dossier).
 *
 * A **private** note is encrypted with the password-wrapped DEK, so reading or
 * writing it requires the session to be unlocked; a regular note is encrypted
 * with the user's open key, which the server can always resolve: that's what
 * lets the feature open without any prompt.
 */
export const noteSchema = z.object({
    id: z.number().int().nonnegative(),
    title: z.string().max(NOTE_TITLE_MAX_LENGTH),
    folderId: z.number().int().positive().nullable(),
    blocks: z.array(noteBlockSchema).max(NOTE_MAX_BLOCKS),
    /** Rank within its folder; lower comes first. Only drag & drop changes it. */
    sortOrder: z.number().int().nonnegative(),
    /** True when the note is encrypted with the password-protected key. */
    private: z.boolean(),
    /** Epoch seconds; set by the server, surfaced for sorting/display. */
    updated: z.number().int().nonnegative(),
    /** Epoch seconds the note was first created. */
    created: z.number().int().nonnegative()
});

export type Note = z.infer<typeof noteSchema>;

/**
 * Lightweight list variant. A private note listed while the session is locked
 * comes back **masked** (metadata only, no `title`/`preview`) so the UI can
 * render a padlock placeholder without the body ever being decrypted.
 */
export const noteSummarySchema = z.object({
    id: z.number().int().nonnegative(),
    title: z.string(),
    folderId: z.number().int().positive().nullable(),
    /** Rank within its folder; lower comes first. Only drag & drop changes it. */
    sortOrder: z.number().int().nonnegative(),
    /** Present only when the body is readable; absent for masked notes. */
    preview: z.string().optional(),
    /** Total checklist items / how many are done, for an at-a-glance summary. */
    checkTotal: z.number().int().nonnegative(),
    checkDone: z.number().int().nonnegative(),
    /** True when the note is encrypted with the password-protected key. */
    private: z.boolean(),
    /** True when the body stayed encrypted for this response (private + locked). */
    masked: z.boolean(),
    /** Epoch seconds the note was archived, or `null` while it is active. */
    archivedAt: z.number().int().nonnegative().nullable(),
    updated: z.number().int().nonnegative(),
    /** Epoch seconds the note was first created. */
    created: z.number().int().nonnegative()
});

export type NoteSummary = z.infer<typeof noteSummarySchema>;

export interface NoteRow {
    id: number;
    user_id: number;
    workspace_id: number | null;
    folder_id: number | null;
    /**
     * Encrypted JSON payload (title + blocks), keyed by the private DEK when
     * `is_private`, by the user's open DEK otherwise.
     */
    content: string;
    /** Manual rank within its folder; lower comes first. */
    sort_order: number;
    /** 1 when the body is encrypted with the password-protected key. */
    is_private: number;
    /**
     * Epoch seconds the note was archived; `NULL` while active. Deleting a note
     * archives it: only an already-archived note can be destroyed for good.
     */
    archived_at: number | null;
    updated: number;
    created: number;
}

export interface NoteFolderRow {
    id: number;
    user_id: number;
    workspace_id: number | null;
    /** Encrypted JSON payload (`{ name }`). */
    content: string;
    /** Manual rank within the user's folders; lower comes first. */
    sort_order: number;
    created: number;
}
