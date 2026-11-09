import { z } from 'zod';

/**
 * Les signatures gardées sur le compte : ce que l'atelier PDF a dessiné,
 * écrit ou importé, pour le retrouver sur tous ses appareils. Scellées en
 * base sous le codec de l'espace personnel, comme le nom d'un fichier
 * converti.
 */

/** Combien un compte en garde au plus, signatures et paraphes confondus. */
export const SIGNATURES_MAX = 6;

/** Une image importée pèse 300 Ko au plus, une fois encodée en base64. */
export const SIGNATURE_IMAGE_MAX_CHARS = 400_000;
export const SIGNATURE_PATH_MAX_CHARS = 60_000;
export const SIGNATURE_TEXT_MAX = 80;

const dimension = z.number().positive().max(10_000);

export const storedSignatureSchema = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('path'),
        path: z.string().min(1).max(SIGNATURE_PATH_MAX_CHARS),
        width: dimension,
        height: dimension,
        stroke: z.number().positive().max(20)
    }),
    z.object({ kind: z.literal('text'), text: z.string().trim().min(1).max(SIGNATURE_TEXT_MAX) }),
    z.object({
        kind: z.literal('image'),
        /** Un PNG, transparence comprise, en base64. */
        png: z.string().min(1).max(SIGNATURE_IMAGE_MAX_CHARS),
        width: z.number().int().positive().max(10_000),
        height: z.number().int().positive().max(10_000)
    })
]);
export type StoredSignature = z.infer<typeof storedSignatureSchema>;

export const signatureRoleSchema = z.enum(['signature', 'initials']);
export type SignatureRole = z.infer<typeof signatureRoleSchema>;

export const savedSignatureSchema = z.object({
    id: z.number().int().positive(),
    role: signatureRoleSchema,
    data: storedSignatureSchema,
    createdAt: z.number().int().nonnegative()
});
export type SavedSignature = z.infer<typeof savedSignatureSchema>;
