import { z } from 'zod';
import { passwordEntryMaskedSchema, passwordEntrySchema } from './domain';

/**
 * Commandes du coffre de mots de passe.
 *
 * L'espace visé n'apparaît dans aucune entrée : il voyage sur l'enveloppe WS
 * (voir `protocol/envelope`) et le dispatcheur le résout avant le handler.
 */

export const passwordList = {
    command: 'password.list' as const,
    input: z.object({}),
    output: z.object({ entries: z.array(passwordEntryMaskedSchema) })
};

/**
 * Compte les entrées de l'espace. Métadonnées claires uniquement (un nombre de
 * lignes, aucun déchiffrement) : contrairement à `password.list`, la commande
 * n'exige jamais que le chiffrement par mot de passe soit déverrouillé, donc le
 * widget d'accueil affiche toujours un nombre, même session verrouillée.
 */
export const passwordCount = {
    command: 'password.count' as const,
    input: z.object({}),
    output: z.object({ count: z.number().int().nonnegative() })
};

export const passwordGet = {
    command: 'password.get' as const,
    input: z.object({ passwordId: z.number().int().positive() }),
    output: z.object({ entry: passwordEntrySchema })
};

export const passwordAdd = {
    command: 'password.add' as const,
    input: z.object({ entry: passwordEntrySchema.omit({ id: true }) }),
    output: z.object({ entry: passwordEntrySchema })
};

export const passwordEdit = {
    command: 'password.edit' as const,
    input: z.object({ entry: passwordEntrySchema }),
    output: z.object({ entry: passwordEntrySchema })
};

export const passwordDelete = {
    command: 'password.delete' as const,
    input: z.object({ passwordId: z.number().int().positive() }),
    output: z.object({ passwordId: z.number().int().positive() })
};

export const passwordCommands = [
    passwordList,
    passwordCount,
    passwordGet,
    passwordAdd,
    passwordEdit,
    passwordDelete
] as const;
