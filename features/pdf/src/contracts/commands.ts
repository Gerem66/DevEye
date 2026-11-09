import { z } from 'zod';

import { savedSignatureSchema, signatureRoleSchema, storedSignatureSchema } from './signatures';

/** Les signatures gardées sur le compte, la plus récente d'abord. */
export const pdfSignatures = {
    command: 'pdf.signatures' as const,
    input: z.object({}),
    output: z.object({ signatures: z.array(savedSignatureSchema) })
};

export const pdfSignatureSave = {
    command: 'pdf.signatureSave' as const,
    input: z.object({ role: signatureRoleSchema, data: storedSignatureSchema }),
    output: z.object({ signature: savedSignatureSchema })
};

export const pdfSignatureRemove = {
    command: 'pdf.signatureRemove' as const,
    input: z.object({ id: z.number().int().positive() }),
    output: z.object({ removed: z.boolean() })
};

export const pdfCommands = [pdfSignatures, pdfSignatureSave, pdfSignatureRemove] as const;
