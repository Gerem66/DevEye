import { z } from 'zod';

export const passwordStatusSchema = z.enum(['active', 'inactive', 'none']);
export type PasswordStatus = z.infer<typeof passwordStatusSchema>;

export const passwordEntrySchema = z.object({
    id: z.number().int().nonnegative(),
    category: z.string(),
    service: z.string(),
    email: z.string(),
    password: z.string(),
    status: passwordStatusSchema
});

export type PasswordEntry = z.infer<typeof passwordEntrySchema>;

/**
 * Variant without the secret payload, used when listing entries before unlock.
 * `hasPassword` tells the UI whether a (still hidden) secret actually exists, so
 * a genuinely empty password renders as a blank cell instead of fake dots with
 * reveal/copy controls that would yield nothing.
 */
export const passwordEntryMaskedSchema = passwordEntrySchema.extend({
    password: z.literal(''),
    hasPassword: z.boolean()
});

export type PasswordEntryMasked = z.infer<typeof passwordEntryMaskedSchema>;

export interface PasswordRow {
    id: number;
    user_id: number;
    workspace_id: number | null;
    content: string;
    date: number;
}
