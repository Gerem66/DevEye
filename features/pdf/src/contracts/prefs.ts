import { z } from 'zod';

/**
 * Les réglages du compte dans l'atelier : les encres personnalisées, et la
 * signature et le paraphe choisis parmi ceux gardés. Dans le magasin de
 * l'espace personnel, relus sur tous ses appareils.
 */

/** Combien d'encres personnalisées un compte garde. */
export const INK_SLOTS = 3;

/** `#rrggbb` en minuscules, tel que le sélecteur de couleur du navigateur le rend. */
export type HexColor = `#${string}`;
const HEX = /^#[0-9a-f]{6}$/;
export const hexColorSchema = z.custom<HexColor>(
    (v) => typeof v === 'string' && HEX.test(v),
    'couleur #rrggbb attendue'
);

export const thumbSizeSchema = z.enum(['small', 'medium', 'large']);
export type ThumbSize = z.infer<typeof thumbSizeSchema>;

export const prefsSchema = z.object({
    /** Un emplacement vaut `null` tant qu'aucune couleur n'y a été choisie. */
    inks: z.array(hexColorSchema.nullable()).length(INK_SLOTS),
    /** L'id d'une signature gardée ; une qui n'existe plus vaut aucune. */
    signature: z.number().int().positive().nullable(),
    initials: z.number().int().positive().nullable(),
    /** La taille des aperçus de l'onglet Pages. */
    thumbs: thumbSizeSchema.default('medium')
});
export type Prefs = z.infer<typeof prefsSchema>;

export const DEFAULT_PREFS: Prefs = { inks: [null, null, null], signature: null, initials: null, thumbs: 'medium' };
